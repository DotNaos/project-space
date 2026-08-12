//go:build !windows

package workspacerun

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"os"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

var retainedStateNamePattern = regexp.MustCompile(`^\.runtime-[A-Za-z0-9_-]{8,128}\.json$`)

type retentionCandidate struct {
	entry          RetentionEntry
	record         runtimeRecord
	tombstoneProof string
	treeProof      string
	snapshots      []retentionSnapshot
}

func (collector *RetentionCollector) scanCandidates(reclaimed map[string]retentionReceipt) ([]retentionCandidate, []RetentionEntry, error) {
	states, statesInfo, err := collector.openBoundSourceDirectory("states")
	if err != nil {
		return nil, nil, fmt.Errorf("open source state directory: %w", err)
	}
	defer states.Close()
	generations, generationsInfo, err := collector.openBoundSourceDirectory("generations")
	if err != nil {
		return nil, nil, fmt.Errorf("open source generation directory: %w", err)
	}
	defer generations.Close()
	for _, info := range []os.FileInfo{statesInfo, generationsInfo} {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != collector.boundary.SourceUID {
			return nil, nil, fmt.Errorf("source namespace owner does not match its root")
		}
	}
	names, err := states.Readdirnames(-1)
	if err != nil {
		return nil, nil, err
	}
	sort.Strings(names)
	var candidates []retentionCandidate
	var failures []RetentionEntry
	for _, name := range names {
		if !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		workspaceID := strings.TrimSuffix(name, ".json")
		if !workspaceIDPattern.MatchString(workspaceID) {
			failures = append(failures, RetentionEntry{WorkspaceID: "invalid", Status: RetentionInvalid, Reason: "invalid canonical state filename"})
			continue
		}
		if collector.canonicalHasReceipt(states, name, reclaimed) {
			continue
		}
		candidate, err := collector.readCandidate(states, generations, collector.boundary.SourceUID, workspaceID, name, names)
		if err != nil {
			failures = append(failures, RetentionEntry{WorkspaceID: workspaceID, Status: RetentionInvalid, Reason: safeRetentionReason(err)})
			continue
		}
		if candidate == nil {
			continue
		}
		candidates = append(candidates, *candidate)
	}
	return candidates, failures, nil
}

func (collector *RetentionCollector) canonicalHasReceipt(states *os.File, name string, reclaimed map[string]retentionReceipt) bool {
	if len(reclaimed) == 0 {
		return false
	}
	record := runtimeRecord{}
	if _, err := readBoundedJSONAt(states, name, &record); err != nil {
		return false
	}
	receipt, ok := reclaimed[record.WorkspaceID+":"+record.Generation]
	return ok && receipt.Archive == record.GenerationArchive && receipt.GenerationProof == record.GenerationProof && receipt.CheckedAt == record.CheckedAt
}

func (collector *RetentionCollector) readCandidate(states, generations *os.File, sourceUID uint32, workspaceID, stateName string, allStateNames []string) (*retentionCandidate, error) {
	record := runtimeRecord{}
	info, err := readBoundedJSONAt(states, stateName, &record)
	if err != nil {
		return nil, fmt.Errorf("read terminal tombstone: %w", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != sourceUID || stat.Nlink != 1 {
		return nil, fmt.Errorf("terminal tombstone owner or link count is invalid")
	}
	identity := WorkspaceIdentity{WorkspaceID: record.WorkspaceID, Repository: record.Repository, Directory: record.Directory, GitDirectory: record.GitDirectory, Branch: record.Branch, Head: record.Head, IdentityProof: record.IdentityProof}
	if err := validateRecord(record, identity); err != nil {
		return nil, fmt.Errorf("terminal tombstone is invalid: %w", err)
	}
	if record.WorkspaceID != workspaceID || !record.GenerationRemoved || record.State != StateStopped && record.State != StateFailed {
		return nil, nil
	}
	checkedAt, _ := time.Parse(time.RFC3339Nano, record.CheckedAt)
	entry := RetentionEntry{WorkspaceID: record.WorkspaceID, Generation: record.Generation, Archive: record.GenerationArchive, GenerationProof: record.GenerationProof, CheckedAt: record.CheckedAt, Status: RetentionEligible}
	if checkedAt.After(collector.now().Add(-collector.options.MinimumAge)) {
		entry.Status, entry.Reason = RetentionDeferred, "terminal tombstone has not reached minimum age"
	}
	archiveInfo, duplicate, err := inspectRetainedArchive(generations, record, sourceUID)
	if err != nil {
		return nil, err
	}
	if duplicate {
		return nil, fmt.Errorf("generation proof is duplicated in the retained namespace")
	}
	if archiveInfo.ModTime().After(collector.now().Add(-collector.options.MinimumAge)) {
		entry.Status, entry.Reason = RetentionDeferred, "retained archive has not reached minimum age"
	}
	bytes, _, treeProof, err := inspectTreeAt(generations, record.GenerationArchive, record.GenerationProof, sourceUID)
	if err != nil {
		return nil, err
	}
	snapshots, snapshotBytes, err := inspectStateSnapshots(states, allStateNames, record, sourceUID)
	if err != nil {
		return nil, err
	}
	if bytes > maximumRetentionProofBytes-snapshotBytes {
		return nil, fmt.Errorf("retention evidence exceeds the safe byte bound")
	}
	entry.Bytes, entry.StateSnapshots = bytes+snapshotBytes, len(snapshots)
	return &retentionCandidate{entry: entry, record: record, tombstoneProof: fileIdentity(info), treeProof: treeProof, snapshots: snapshots}, nil
}

func inspectRetainedArchive(generations *os.File, record runtimeRecord, sourceUID uint32) (os.FileInfo, bool, error) {
	if _, err := generations.Seek(0, 0); err != nil {
		return nil, false, err
	}
	names, err := generations.Readdirnames(-1)
	if err != nil {
		return nil, false, err
	}
	var matched os.FileInfo
	matches := 0
	for _, name := range names {
		if !strings.HasPrefix(name, ".retained-") {
			continue
		}
		fd, openErr := unix.Openat(int(generations.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if openErr != nil {
			continue
		}
		file := os.NewFile(uintptr(fd), name)
		info, statErr := file.Stat()
		_ = file.Close()
		if statErr != nil {
			return nil, false, statErr
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if fileIdentity(info) == record.GenerationProof {
			if !ok || stat.Uid != sourceUID || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
				return nil, false, fmt.Errorf("retained generation ownership is invalid")
			}
			matches++
			if name == record.GenerationArchive {
				matched = info
			}
		}
	}
	if matched == nil {
		return nil, false, fmt.Errorf("proof-bound retained generation is missing or moved")
	}
	return matched, matches != 1, nil
}

func inspectStateSnapshots(states *os.File, names []string, terminal runtimeRecord, sourceUID uint32) ([]retentionSnapshot, int64, error) {
	groups := map[string][]retentionSnapshot{}
	sizes := map[string]int64{}
	links := map[string]uint64{}
	for _, name := range names {
		if !retainedStateNamePattern.MatchString(name) {
			continue
		}
		record := runtimeRecord{}
		info, err := readBoundedJSONAt(states, name, &record)
		if err != nil {
			return nil, 0, fmt.Errorf("retained state snapshot %q is invalid: %w", name, err)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != sourceUID {
			return nil, 0, fmt.Errorf("retained state snapshot owner is invalid")
		}
		identity := WorkspaceIdentity{WorkspaceID: record.WorkspaceID, Repository: record.Repository, Directory: record.Directory, GitDirectory: record.GitDirectory, Branch: record.Branch, Head: record.Head, IdentityProof: record.IdentityProof}
		if err := validateRecord(record, identity); err != nil {
			return nil, 0, fmt.Errorf("retained state snapshot is invalid: %w", err)
		}
		if record.WorkspaceID != terminal.WorkspaceID || record.Generation != terminal.Generation || record.GenerationProof != terminal.GenerationProof {
			continue
		}
		proof := fileIdentity(info)
		groups[proof] = append(groups[proof], retentionSnapshot{SourceName: name, Proof: proof})
		sizes[proof], links[proof] = info.Size(), uint64(stat.Nlink)
	}
	var result []retentionSnapshot
	var bytes int64
	for proof, group := range groups {
		if links[proof] != uint64(len(group)) {
			return nil, 0, fmt.Errorf("retained state snapshot has a foreign hardlink")
		}
		for index := range group {
			group[index].StageName = "state-" + recordSafeNonce() + ".json"
			result = append(result, group[index])
		}
		if sizes[proof] < 0 || bytes > maximumRetentionProofBytes-sizes[proof] {
			return nil, 0, fmt.Errorf("retained state snapshots exceed the safe byte bound")
		}
		bytes += sizes[proof]
	}
	sort.Slice(result, func(i, j int) bool { return result[i].SourceName < result[j].SourceName })
	return result, bytes, nil
}

func inspectTreeAt(parent *os.File, name, proof string, sourceUID uint32) (int64, int, string, error) {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return 0, 0, "", err
	}
	root := os.NewFile(uintptr(fd), name)
	defer root.Close()
	info, err := root.Stat()
	if err != nil || fileIdentity(info) != proof {
		return 0, 0, "", errors.Join(err, fmt.Errorf("retained generation proof changed"))
	}
	digest := sha256.New()
	bytes, entries, err := inspectTree(root, sourceUID, 0, "", digest)
	return bytes, entries, hex.EncodeToString(digest.Sum(nil)), err
}

func inspectTree(directory *os.File, sourceUID uint32, entries int, prefix string, digest hash.Hash) (int64, int, error) {
	names, err := directory.Readdirnames(-1)
	if err != nil {
		return 0, entries, err
	}
	sort.Strings(names)
	var bytes int64
	for _, name := range names {
		entries++
		if entries > maximumRetentionEntries || name == "." || name == ".." || strings.ContainsAny(name, "/\x00") {
			return 0, entries, fmt.Errorf("retained generation exceeds safe entry bounds")
		}
		var stat unix.Stat_t
		if err := unix.Fstatat(int(directory.Fd()), name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return 0, entries, err
		}
		if stat.Uid != sourceUID || stat.Mode&0o077 != 0 {
			return 0, entries, fmt.Errorf("retained generation contains foreign or non-private content")
		}
		path := name
		if prefix != "" {
			path = prefix + "/" + name
		}
		fmt.Fprintf(digest, "%d:%s:%x:%x:%x:%x\n", len(path), path, uint64(stat.Dev), stat.Ino, stat.Mode, stat.Size)
		switch stat.Mode & unix.S_IFMT {
		case unix.S_IFREG:
			if stat.Nlink != 1 {
				return 0, entries, fmt.Errorf("retained generation contains hardlinked content")
			}
			if stat.Size < 0 || bytes > maximumRetentionProofBytes-stat.Size {
				return 0, entries, fmt.Errorf("retained generation exceeds the safe byte bound")
			}
			bytes += stat.Size
		case unix.S_IFDIR:
			fd, err := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
			if err != nil {
				return 0, entries, err
			}
			child := os.NewFile(uintptr(fd), name)
			childBytes, childEntries, childErr := inspectTree(child, sourceUID, entries, path, digest)
			_ = child.Close()
			if childErr != nil {
				return 0, entries, childErr
			}
			if bytes > maximumRetentionProofBytes-childBytes {
				return 0, entries, fmt.Errorf("retained generation exceeds the safe byte bound")
			}
			bytes, entries = bytes+childBytes, childEntries
		default:
			return 0, entries, fmt.Errorf("retained generation contains a symlink or special file")
		}
	}
	return bytes, entries, nil
}
