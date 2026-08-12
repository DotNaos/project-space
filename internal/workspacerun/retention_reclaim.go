//go:build !windows

package workspacerun

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const retentionIntentVersion = 1

func (collector *RetentionCollector) reclaim(candidate retentionCandidate) (RetentionEntry, error) {
	if candidate.entry.Status != RetentionEligible {
		return candidate.entry, nil
	}
	intent := retentionIntent{
		Version: retentionIntentVersion, WorkspaceID: candidate.record.WorkspaceID,
		Generation: candidate.record.Generation, Archive: candidate.record.GenerationArchive,
		GenerationProof: candidate.record.GenerationProof, CheckedAt: candidate.record.CheckedAt,
		TreeProof: candidate.treeProof, TombstoneProof: candidate.tombstoneProof,
		State: "prepared", StageName: "generation-" + recordSafeNonce(),
		Snapshots: candidate.snapshots, Bytes: candidate.entry.Bytes,
	}
	if err := validateRetentionIntent(intent); err != nil {
		return candidate.entry, err
	}
	if err := collector.writeIntent(intent); err != nil {
		return candidate.entry, err
	}
	if collector.afterPrepare != nil {
		if err := collector.afterPrepare(); err != nil {
			return candidate.entry, err
		}
	}
	return collector.completeIntent(intent)
}

func (collector *RetentionCollector) resumeIntents(report *RetentionReport) error {
	directory, _, err := openPrivateDirectory(filepath.Join(collector.options.CollectorRoot, "intents"))
	if err != nil {
		return err
	}
	defer directory.Close()
	names, err := directory.Readdirnames(-1)
	if err != nil {
		return err
	}
	for _, name := range names {
		if !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		intent := retentionIntent{}
		if _, err := readBoundedJSONAt(directory, name, &intent); err != nil || validateRetentionIntent(intent) != nil || name != retentionIntentName(intent) {
			return errors.Join(err, fmt.Errorf("collector intent %q is invalid", name))
		}
		entry, err := collector.completeIntent(intent)
		if err != nil {
			return fmt.Errorf("resume collector intent %q: %w", name, err)
		}
		report.ReclaimedBytes += entry.Bytes
		report.Entries = append(report.Entries, entry)
	}
	return nil
}

func validateRetentionIntent(intent retentionIntent) error {
	if intent.Version != retentionIntentVersion || !workspaceIDPattern.MatchString(intent.WorkspaceID) ||
		!uuidPattern.MatchString(intent.Generation) || !filesystemIdentityPattern.MatchString(intent.GenerationProof) ||
		!sha256Pattern.MatchString(intent.TreeProof) || !filesystemIdentityPattern.MatchString(intent.TombstoneProof) ||
		!strings.HasPrefix(intent.Archive, ".retained-"+intent.Generation+"-") || len(intent.Archive) > 128 ||
		!safeRetentionName(intent.StageName, "generation-") || intent.Bytes < 0 || intent.Bytes > maximumRetentionProofBytes {
		return fmt.Errorf("collector intent identity is invalid")
	}
	if _, err := time.Parse(time.RFC3339Nano, intent.CheckedAt); err != nil {
		return fmt.Errorf("collector intent time is invalid")
	}
	if intent.State != "prepared" && intent.State != "claimed" && intent.State != "deleting" {
		return fmt.Errorf("collector intent state is invalid")
	}
	if len(intent.Snapshots) > maximumRetentionEntries {
		return fmt.Errorf("collector intent has too many state snapshots")
	}
	seenSource, seenStage := map[string]bool{}, map[string]bool{}
	for _, snapshot := range intent.Snapshots {
		if !retainedStateNamePattern.MatchString(snapshot.SourceName) || !safeRetentionName(snapshot.StageName, "state-") ||
			!filesystemIdentityPattern.MatchString(snapshot.Proof) || seenSource[snapshot.SourceName] || seenStage[snapshot.StageName] {
			return fmt.Errorf("collector state snapshot identity is invalid")
		}
		seenSource[snapshot.SourceName], seenStage[snapshot.StageName] = true, true
	}
	return nil
}

func safeRetentionName(name, prefix string) bool {
	return strings.HasPrefix(name, prefix) && len(name) <= 180 && !strings.ContainsAny(name, "/\\\x00") && name != prefix
}

func retentionIntentName(intent retentionIntent) string {
	return intent.WorkspaceID + "-" + intent.Generation + ".json"
}

func retentionReceiptName(workspaceID, generation string) string {
	return workspaceID + "-" + generation + ".json"
}

func (collector *RetentionCollector) writeIntent(intent retentionIntent) error {
	return writeCollectorJSON(filepath.Join(collector.options.CollectorRoot, "intents"), retentionIntentName(intent), intent)
}

func (collector *RetentionCollector) completeIntent(intent retentionIntent) (RetentionEntry, error) {
	if receipt, ok, err := collector.readReceipt(intent.WorkspaceID, intent.Generation); err != nil {
		return RetentionEntry{}, err
	} else if ok {
		if receipt.GenerationProof != intent.GenerationProof || receipt.Archive != intent.Archive {
			return RetentionEntry{}, fmt.Errorf("terminal receipt conflicts with collector intent")
		}
		_ = collector.removeIntent(intent)
		return receiptEntry(receipt), nil
	}
	if intent.State != "deleting" {
		if err := collector.claimEvidence(&intent); err != nil {
			return RetentionEntry{}, err
		}
		intent.State = "claimed"
		if err := collector.writeIntent(intent); err != nil {
			return RetentionEntry{}, err
		}
		if collector.afterClaim != nil {
			if err := collector.afterClaim(); err != nil {
				return RetentionEntry{}, err
			}
		}
		if err := collector.verifyClaimed(intent); err != nil {
			return RetentionEntry{}, err
		}
		intent.State = "deleting"
		if err := collector.writeIntent(intent); err != nil {
			return RetentionEntry{}, err
		}
	}
	if err := collector.deleteClaimed(intent); err != nil {
		return RetentionEntry{}, err
	}
	if collector.afterDelete != nil {
		if err := collector.afterDelete(); err != nil {
			return RetentionEntry{}, err
		}
	}
	reclaimedAt := collector.now().UTC().Format(time.RFC3339Nano)
	receipt := retentionReceipt{Version: retentionIntentVersion, WorkspaceID: intent.WorkspaceID, Generation: intent.Generation, Archive: intent.Archive, GenerationProof: intent.GenerationProof, CheckedAt: intent.CheckedAt, ReclaimedAt: reclaimedAt, Bytes: intent.Bytes, StateSnapshots: len(intent.Snapshots)}
	if err := writeCollectorJSON(filepath.Join(collector.options.CollectorRoot, "receipts"), retentionReceiptName(intent.WorkspaceID, intent.Generation), receipt); err != nil {
		return RetentionEntry{}, err
	}
	if err := collector.removeIntent(intent); err != nil {
		return RetentionEntry{}, err
	}
	return receiptEntry(receipt), nil
}

func receiptEntry(receipt retentionReceipt) RetentionEntry {
	return RetentionEntry{WorkspaceID: receipt.WorkspaceID, Generation: receipt.Generation, Archive: receipt.Archive, GenerationProof: receipt.GenerationProof, CheckedAt: receipt.CheckedAt, Status: RetentionReclaimed, Bytes: receipt.Bytes, StateSnapshots: receipt.StateSnapshots, ReclaimedAt: receipt.ReclaimedAt}
}

func (collector *RetentionCollector) claimEvidence(intent *retentionIntent) error {
	sourceGenerations, _, err := collector.openBoundSourceDirectory("generations")
	if err != nil {
		return err
	}
	defer sourceGenerations.Close()
	staging, _, err := openPrivateDirectory(filepath.Join(collector.options.CollectorRoot, "staging"))
	if err != nil {
		return err
	}
	defer staging.Close()
	if err := claimDirectoryAt(sourceGenerations, intent.Archive, staging, intent.StageName, intent.GenerationProof, collector.beforeClaimRename); err != nil {
		return fmt.Errorf("claim proof-bound generation: %w", err)
	}
	sourceStates, _, err := collector.openBoundSourceDirectory("states")
	if err != nil {
		return err
	}
	defer sourceStates.Close()
	for _, snapshot := range intent.Snapshots {
		if err := claimRegularAt(sourceStates, snapshot.SourceName, staging, snapshot.StageName, snapshot.Proof, nil); err != nil {
			return fmt.Errorf("claim state snapshot: %w", err)
		}
	}
	if collector.afterClaimTransfer != nil {
		if err := collector.afterClaimTransfer(*intent); err != nil {
			return err
		}
	}
	if err := takeExclusiveTreeAt(staging, intent.StageName, intent.GenerationProof, collector.boundary.SourceUID, uint32(os.Geteuid())); err != nil {
		return fmt.Errorf("take exclusive generation ownership: %w", err)
	}
	for _, snapshot := range intent.Snapshots {
		if err := takeExclusiveRegularAt(staging, snapshot.StageName, snapshot.Proof, collector.boundary.SourceUID, uint32(os.Geteuid())); err != nil {
			return fmt.Errorf("take exclusive state ownership: %w", err)
		}
	}
	if err := sourceGenerations.Sync(); err != nil {
		return err
	}
	if err := sourceStates.Sync(); err != nil {
		return err
	}
	return staging.Sync()
}

func claimDirectoryAt(source *os.File, sourceName string, target *os.File, targetName, proof string, beforeRename func() error) error {
	return claimAt(source, sourceName, target, targetName, proof, true, beforeRename)
}

func claimRegularAt(source *os.File, sourceName string, target *os.File, targetName, proof string, beforeRename func() error) error {
	return claimAt(source, sourceName, target, targetName, proof, false, beforeRename)
}

func claimAt(source *os.File, sourceName string, target *os.File, targetName, proof string, directory bool, beforeRename func() error) error {
	flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW
	if directory {
		flags |= unix.O_DIRECTORY
	}
	sourceFD, sourceErr := unix.Openat(int(source.Fd()), sourceName, flags, 0)
	targetFD, targetErr := unix.Openat(int(target.Fd()), targetName, flags, 0)
	if sourceErr != nil && targetErr == nil && errors.Is(sourceErr, syscall.ENOENT) {
		targetFile := os.NewFile(uintptr(targetFD), targetName)
		defer targetFile.Close()
		info, err := targetFile.Stat()
		if err != nil || fileIdentity(info) != proof {
			return errors.Join(err, fmt.Errorf("previously claimed evidence changed"))
		}
		return nil
	}
	if targetErr == nil {
		unix.Close(targetFD)
		if sourceFD >= 0 {
			unix.Close(sourceFD)
		}
		return fmt.Errorf("source and claimed evidence both exist")
	}
	if !errors.Is(targetErr, syscall.ENOENT) {
		if sourceFD >= 0 {
			unix.Close(sourceFD)
		}
		return targetErr
	}
	if sourceErr != nil {
		return sourceErr
	}
	sourceFile := os.NewFile(uintptr(sourceFD), sourceName)
	defer sourceFile.Close()
	sourceInfo, err := sourceFile.Stat()
	if err != nil || fileIdentity(sourceInfo) != proof {
		return errors.Join(err, fmt.Errorf("source evidence identity changed"))
	}
	if beforeRename != nil {
		if err := beforeRename(); err != nil {
			return err
		}
	}
	if err := unix.Renameat(int(source.Fd()), sourceName, int(target.Fd()), targetName); err != nil {
		return err
	}
	claimedFD, err := unix.Openat(int(target.Fd()), targetName, flags, 0)
	if err != nil {
		return err
	}
	claimed := os.NewFile(uintptr(claimedFD), targetName)
	claimedInfo, claimedErr := claimed.Stat()
	_ = claimed.Close()
	if claimedErr != nil || !os.SameFile(sourceInfo, claimedInfo) || fileIdentity(claimedInfo) != proof {
		return errors.Join(claimedErr, fmt.Errorf("claimed evidence identity changed during transfer"))
	}
	return nil
}

func (collector *RetentionCollector) verifyClaimed(intent retentionIntent) error {
	if err := collector.verifyTerminalTombstone(intent); err != nil {
		return err
	}
	staging, _, err := openPrivateDirectory(filepath.Join(collector.options.CollectorRoot, "staging"))
	if err != nil {
		return err
	}
	defer staging.Close()
	collectorUID := uint32(os.Geteuid())
	bytes, _, treeProof, err := inspectTreeAt(staging, intent.StageName, intent.GenerationProof, collectorUID)
	if err != nil {
		return err
	}
	if bytes > intent.Bytes || bytes > collector.options.MaximumBytes {
		return fmt.Errorf("claimed generation exceeds its bounded evidence")
	}
	if treeProof != intent.TreeProof {
		return fmt.Errorf("claimed generation contents changed before exclusive ownership")
	}
	proofCounts := map[string]int{}
	proofLinks := map[string]uint64{}
	for _, snapshot := range intent.Snapshots {
		fd, err := unix.Openat(int(staging.Fd()), snapshot.StageName, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(fd), snapshot.StageName)
		info, statErr := file.Stat()
		_ = file.Close()
		stat, ok := info.Sys().(*syscall.Stat_t)
		if statErr != nil || !ok || !info.Mode().IsRegular() || fileIdentity(info) != snapshot.Proof || stat.Uid != collectorUID {
			return errors.Join(statErr, fmt.Errorf("claimed state snapshot identity changed"))
		}
		proofCounts[snapshot.Proof]++
		proofLinks[snapshot.Proof] = uint64(stat.Nlink)
	}
	for proof, count := range proofCounts {
		if proofLinks[proof] != uint64(count) {
			return fmt.Errorf("claimed state snapshot %s has a foreign hardlink", proof)
		}
	}
	return nil
}

func takeExclusiveTreeAt(parent *os.File, name, proof string, sourceOwner, collectorOwner uint32) error {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	directory := os.NewFile(uintptr(fd), name)
	defer directory.Close()
	info, err := directory.Stat()
	stat, ok := info.Sys().(*syscall.Stat_t)
	if err != nil || !ok || fileIdentity(info) != proof || stat.Uid != sourceOwner && stat.Uid != collectorOwner {
		return errors.Join(err, fmt.Errorf("claimed generation proof changed before ownership transfer"))
	}
	if err := directory.Chown(int(collectorOwner), -1); err != nil {
		return err
	}
	if err := directory.Chmod(0o700); err != nil {
		return err
	}
	if err := takeExclusiveContents(directory, sourceOwner, collectorOwner); err != nil {
		return err
	}
	return directory.Sync()
}

func takeExclusiveContents(directory *os.File, sourceOwner, collectorOwner uint32) error {
	names, err := directory.Readdirnames(-1)
	if err != nil {
		return err
	}
	for _, name := range names {
		var stat unix.Stat_t
		if err := unix.Fstatat(int(directory.Fd()), name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		if stat.Uid != sourceOwner && stat.Uid != collectorOwner || stat.Mode&0o077 != 0 {
			return fmt.Errorf("claimed generation contains foreign or non-private content")
		}
		flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW
		if stat.Mode&unix.S_IFMT == unix.S_IFDIR {
			flags |= unix.O_DIRECTORY
		} else if stat.Mode&unix.S_IFMT != unix.S_IFREG {
			return fmt.Errorf("claimed generation contains a non-regular entry")
		}
		fd, err := unix.Openat(int(directory.Fd()), name, flags, 0)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(fd), name)
		if stat.Mode&unix.S_IFMT == unix.S_IFDIR {
			if err := file.Chown(int(collectorOwner), -1); err != nil {
				_ = file.Close()
				return err
			}
			if err := file.Chmod(0o700); err != nil {
				_ = file.Close()
				return err
			}
			if err := takeExclusiveContents(file, sourceOwner, collectorOwner); err != nil {
				_ = file.Close()
				return err
			}
		} else if err := file.Chmod(0o600); err != nil {
			_ = file.Close()
			return err
		}
		if err := file.Chown(int(collectorOwner), -1); err != nil {
			_ = file.Close()
			return err
		}
		if err := file.Close(); err != nil {
			return err
		}
	}
	return nil
}

func takeExclusiveRegularAt(parent *os.File, name, proof string, sourceOwner, collectorOwner uint32) error {
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	info, err := file.Stat()
	stat, ok := info.Sys().(*syscall.Stat_t)
	if err != nil || !ok || !info.Mode().IsRegular() || fileIdentity(info) != proof || stat.Uid != sourceOwner && stat.Uid != collectorOwner {
		return errors.Join(err, fmt.Errorf("claimed state proof changed before ownership transfer"))
	}
	if err := file.Chown(int(collectorOwner), -1); err != nil {
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	return file.Sync()
}

func (collector *RetentionCollector) verifyTerminalTombstone(intent retentionIntent) error {
	states, _, err := collector.openBoundSourceDirectory("states")
	if err != nil {
		return err
	}
	defer states.Close()
	record := runtimeRecord{}
	info, err := readBoundedJSONAt(states, intent.WorkspaceID+".json", &record)
	if err != nil {
		return err
	}
	if fileIdentity(info) != intent.TombstoneProof {
		return fmt.Errorf("terminal tombstone identity changed")
	}
	identity := WorkspaceIdentity{WorkspaceID: record.WorkspaceID, Repository: record.Repository, Directory: record.Directory, GitDirectory: record.GitDirectory, Branch: record.Branch, Head: record.Head, IdentityProof: record.IdentityProof}
	if err := validateRecord(record, identity); err != nil {
		return fmt.Errorf("terminal tombstone became invalid: %w", err)
	}
	if record.WorkspaceID != intent.WorkspaceID || record.Generation != intent.Generation || record.GenerationArchive != intent.Archive || record.GenerationProof != intent.GenerationProof || record.CheckedAt != intent.CheckedAt || !record.GenerationRemoved || record.State != StateStopped && record.State != StateFailed || record.Handle.Kind != "" || len(record.DevServers) != 0 {
		return fmt.Errorf("terminal runtime absence evidence changed")
	}
	workspaceParent := filepath.Join(collector.options.SourceRoot, "generations", intent.WorkspaceID)
	parent, _, err := openPrivateDirectory(workspaceParent)
	if err != nil {
		return err
	}
	defer parent.Close()
	var stat unix.Stat_t
	if err := unix.Fstatat(int(parent.Fd()), intent.Generation, &stat, unix.AT_SYMLINK_NOFOLLOW); !errors.Is(err, syscall.ENOENT) {
		return fmt.Errorf("active runtime generation reappeared")
	}
	return nil
}

func (collector *RetentionCollector) deleteClaimed(intent retentionIntent) error {
	staging, _, err := openPrivateDirectory(filepath.Join(collector.options.CollectorRoot, "staging"))
	if err != nil {
		return err
	}
	defer staging.Close()
	var stat unix.Stat_t
	if err := unix.Fstatat(int(staging.Fd()), intent.StageName, &stat, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		if err := removeExclusiveTreeAt(staging, intent.StageName, intent.GenerationProof); err != nil {
			return err
		}
	} else if !errors.Is(err, syscall.ENOENT) {
		return err
	}
	for _, snapshot := range intent.Snapshots {
		if err := unix.Unlinkat(int(staging.Fd()), snapshot.StageName, 0); err != nil && !errors.Is(err, syscall.ENOENT) {
			return err
		}
	}
	return staging.Sync()
}

func (collector *RetentionCollector) removeIntent(intent retentionIntent) error {
	directory, _, err := openPrivateDirectory(filepath.Join(collector.options.CollectorRoot, "intents"))
	if err != nil {
		return err
	}
	defer directory.Close()
	if err := unix.Unlinkat(int(directory.Fd()), retentionIntentName(intent), 0); err != nil && !errors.Is(err, syscall.ENOENT) {
		return err
	}
	return directory.Sync()
}

func (collector *RetentionCollector) readReceipt(workspaceID, generation string) (retentionReceipt, bool, error) {
	directory, _, err := openPrivateDirectory(filepath.Join(collector.options.CollectorRoot, "receipts"))
	if err != nil {
		return retentionReceipt{}, false, err
	}
	defer directory.Close()
	receipt := retentionReceipt{}
	_, err = readBoundedJSONAt(directory, retentionReceiptName(workspaceID, generation), &receipt)
	if errors.Is(err, syscall.ENOENT) {
		return retentionReceipt{}, false, nil
	}
	if err != nil {
		return retentionReceipt{}, false, err
	}
	if err := validateRetentionReceipt(receipt); err != nil || receipt.WorkspaceID != workspaceID || receipt.Generation != generation {
		return retentionReceipt{}, false, fmt.Errorf("collector receipt is invalid")
	}
	return receipt, true, nil
}

func (collector *RetentionCollector) listReceipts() ([]retentionReceipt, error) {
	directory, _, err := openPrivateDirectory(filepath.Join(collector.options.CollectorRoot, "receipts"))
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	names, err := directory.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	result := make([]retentionReceipt, 0, len(names))
	for _, name := range names {
		if strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".json") {
			continue
		}
		receipt := retentionReceipt{}
		if _, err := readBoundedJSONAt(directory, name, &receipt); err != nil || name != retentionReceiptName(receipt.WorkspaceID, receipt.Generation) || validateRetentionReceipt(receipt) != nil {
			return nil, errors.Join(err, fmt.Errorf("collector receipt %q is invalid", name))
		}
		result = append(result, receipt)
	}
	return result, nil
}

func validateRetentionReceipt(receipt retentionReceipt) error {
	if receipt.Version != retentionIntentVersion || !workspaceIDPattern.MatchString(receipt.WorkspaceID) ||
		!uuidPattern.MatchString(receipt.Generation) || !filesystemIdentityPattern.MatchString(receipt.GenerationProof) ||
		!strings.HasPrefix(receipt.Archive, ".retained-"+receipt.Generation+"-") || len(receipt.Archive) > 128 ||
		receipt.Bytes < 0 || receipt.Bytes > maximumRetentionProofBytes || receipt.StateSnapshots < 0 || receipt.StateSnapshots > maximumRetentionEntries {
		return fmt.Errorf("collector receipt identity is invalid")
	}
	if _, err := time.Parse(time.RFC3339Nano, receipt.CheckedAt); err != nil {
		return err
	}
	if _, err := time.Parse(time.RFC3339Nano, receipt.ReclaimedAt); err != nil {
		return err
	}
	return nil
}
