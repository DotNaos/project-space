//go:build !windows

package workspacerun

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type RetentionCollector struct {
	options            RetentionOptions
	boundary           retentionBoundary
	now                func() time.Time
	allowSameOwner     bool
	afterPrepare       func() error
	afterClaim         func() error
	afterDelete        func() error
	beforeClaimRename  func() error
	afterClaimTransfer func(retentionIntent) error
}

func NewRetentionCollector(options RetentionOptions) (*RetentionCollector, error) {
	return newRetentionCollector(options, false)
}

func newRetentionCollector(options RetentionOptions, allowSameOwner bool) (*RetentionCollector, error) {
	var err error
	options.SourceRoot, err = filepath.Abs(options.SourceRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve Workspace Runtime source root: %w", err)
	}
	options.CollectorRoot, err = filepath.Abs(options.CollectorRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve Workspace Runtime collector root: %w", err)
	}
	if options.SourceRoot == options.CollectorRoot || strings.HasPrefix(options.CollectorRoot+string(os.PathSeparator), options.SourceRoot+string(os.PathSeparator)) {
		return nil, fmt.Errorf("collector root must be outside the Workspace-owned state root")
	}
	if options.MinimumAge == 0 {
		options.MinimumAge = defaultRetentionMinimumAge
	}
	if options.MaximumBytes == 0 {
		options.MaximumBytes = defaultRetentionMaxBytes
	}
	if options.MinimumAge < 0 || options.MaximumBytes <= 0 {
		return nil, fmt.Errorf("retention age and byte limit must be positive")
	}
	collector := &RetentionCollector{options: options, now: time.Now, allowSameOwner: allowSameOwner}
	if err := collector.validateBoundary(); err != nil {
		return nil, err
	}
	for _, name := range []string{"intents", "staging", "receipts"} {
		if err := ensureCollectorDirectory(options.CollectorRoot, name); err != nil {
			return nil, err
		}
	}
	if err := collector.bindBoundary(); err != nil {
		return nil, err
	}
	return collector, nil
}

func (collector *RetentionCollector) validateBoundary() error {
	source, err := privateDirectoryInfo(collector.options.SourceRoot)
	if err != nil {
		return fmt.Errorf("Workspace Runtime source boundary: %w", err)
	}
	target, err := privateDirectoryInfo(collector.options.CollectorRoot)
	if err != nil {
		return fmt.Errorf("collector boundary: %w", err)
	}
	sourceStat, sourceOK := source.Sys().(*syscall.Stat_t)
	targetStat, targetOK := target.Sys().(*syscall.Stat_t)
	if !sourceOK || !targetOK || sourceStat.Dev != targetStat.Dev {
		return fmt.Errorf("source and collector roots must have stable identities on the same filesystem")
	}
	if !collector.allowSameOwner && (os.Geteuid() != 0 || sourceStat.Uid == 0 || targetStat.Uid != 0) {
		return fmt.Errorf("collector must run as root across a non-root Workspace owner and a root-owned collector directory")
	}
	return nil
}

func privateDirectoryInfo(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.Join(err, fmt.Errorf("%q must be an existing private directory", path))
	}
	return info, nil
}

func ensureCollectorDirectory(root, name string) error {
	path := filepath.Join(root, name)
	if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("create collector directory %q: %w", name, err)
	}
	info, err := privateDirectoryInfo(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("collector directory %q is not collector-owned", name)
	}
	return nil
}

func (collector *RetentionCollector) Status() (RetentionReport, error) {
	return collector.withLock(false)
}

func (collector *RetentionCollector) Collect() (RetentionReport, error) {
	return collector.withLock(true)
}

func (collector *RetentionCollector) withLock(reclaim bool) (RetentionReport, error) {
	root, _, err := openPrivateDirectory(collector.options.CollectorRoot)
	if err != nil {
		return RetentionReport{}, err
	}
	defer root.Close()
	fd, err := unix.Openat(int(root.Fd()), "collector.lock", unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return RetentionReport{}, err
	}
	lock := os.NewFile(uintptr(fd), "collector.lock")
	defer lock.Close()
	info, err := lock.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return RetentionReport{}, errors.Join(err, fmt.Errorf("collector lock is not a private regular file"))
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return RetentionReport{}, err
	}
	defer func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) }()
	return collector.inspect(reclaim)
}

func (collector *RetentionCollector) inspect(reclaim bool) (RetentionReport, error) {
	if err := collector.validateBoundary(); err != nil {
		return RetentionReport{}, err
	}
	if err := collector.verifyBoundNamespace(); err != nil {
		return RetentionReport{}, err
	}
	report := RetentionReport{SourceRoot: collector.options.SourceRoot, CollectorRoot: collector.options.CollectorRoot, CheckedAt: collector.now().UTC().Format(time.RFC3339Nano), Entries: []RetentionEntry{}}
	if reclaim {
		if err := collector.resumeIntents(&report); err != nil {
			return report, err
		}
	}
	reclaimed := map[string]retentionReceipt{}
	receipts, err := collector.listReceipts()
	if err != nil {
		return report, err
	}
	for _, receipt := range receipts {
		key := receipt.WorkspaceID + ":" + receipt.Generation
		reclaimed[key] = receipt
		alreadyReported := false
		for _, entry := range report.Entries {
			alreadyReported = alreadyReported || entry.WorkspaceID == receipt.WorkspaceID && entry.Generation == receipt.Generation
		}
		if !alreadyReported {
			report.Entries = append(report.Entries, receiptEntry(receipt))
		}
	}
	candidates, failures, err := collector.scanCandidates(reclaimed)
	if err != nil {
		return report, err
	}
	report.Entries = append(report.Entries, failures...)
	for _, candidate := range candidates {
		entry := candidate.entry
		if !reclaim {
			report.Entries = append(report.Entries, entry)
			continue
		}
		if report.ReclaimedBytes+entry.Bytes > collector.options.MaximumBytes {
			entry.Status, entry.Reason = RetentionDeferred, "collector byte budget reached"
			report.Entries = append(report.Entries, entry)
			continue
		}
		reclaimed, err := collector.reclaim(candidate)
		if err != nil {
			entry.Status, entry.Reason = RetentionInvalid, safeRetentionReason(err)
			report.Entries = append(report.Entries, entry)
			continue
		}
		report.ReclaimedBytes += reclaimed.Bytes
		report.Entries = append(report.Entries, reclaimed)
	}
	sort.Slice(report.Entries, func(i, j int) bool {
		if report.Entries[i].WorkspaceID == report.Entries[j].WorkspaceID {
			return report.Entries[i].Generation < report.Entries[j].Generation
		}
		return report.Entries[i].WorkspaceID < report.Entries[j].WorkspaceID
	})
	return report, nil
}

func (collector *RetentionCollector) bindBoundary() error {
	source, _ := privateDirectoryInfo(collector.options.SourceRoot)
	states, err := privateDirectoryInfo(filepath.Join(collector.options.SourceRoot, "states"))
	if err != nil {
		return err
	}
	generations, err := privateDirectoryInfo(filepath.Join(collector.options.SourceRoot, "generations"))
	if err != nil {
		return err
	}
	target, _ := privateDirectoryInfo(collector.options.CollectorRoot)
	sourceStat := source.Sys().(*syscall.Stat_t)
	want := retentionBoundary{
		Version: retentionIntentVersion, SourceRoot: collector.options.SourceRoot,
		SourceProof: fileIdentity(source), StatesProof: fileIdentity(states), GenerationsProof: fileIdentity(generations),
		SourceUID: sourceStat.Uid, CollectorRoot: collector.options.CollectorRoot, CollectorProof: fileIdentity(target),
	}
	path := filepath.Join(collector.options.CollectorRoot, "boundary.json")
	current := retentionBoundary{}
	if err := readCollectorJSON(path, &current); err == nil {
		if current != want {
			return fmt.Errorf("collector boundary identity changed")
		}
		collector.boundary = current
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read collector boundary: %w", err)
	}
	if err := writeCollectorJSONExclusive(collector.options.CollectorRoot, "boundary.json", want); err != nil {
		return err
	}
	collector.boundary = want
	return nil
}

func (collector *RetentionCollector) verifyBoundNamespace() error {
	checks := []struct {
		path  string
		proof string
	}{
		{collector.options.SourceRoot, collector.boundary.SourceProof},
		{filepath.Join(collector.options.SourceRoot, "states"), collector.boundary.StatesProof},
		{filepath.Join(collector.options.SourceRoot, "generations"), collector.boundary.GenerationsProof},
		{collector.options.CollectorRoot, collector.boundary.CollectorProof},
	}
	for _, check := range checks {
		info, err := privateDirectoryInfo(check.path)
		if err != nil || fileIdentity(info) != check.proof {
			return errors.Join(err, fmt.Errorf("bound retention namespace identity changed"))
		}
	}
	return nil
}

func (collector *RetentionCollector) openBoundSourceDirectory(name string) (*os.File, os.FileInfo, error) {
	file, info, err := openPrivateDirectory(filepath.Join(collector.options.SourceRoot, name))
	if err != nil {
		return nil, nil, err
	}
	expected := collector.boundary.SourceProof
	if name == "states" {
		expected = collector.boundary.StatesProof
	} else if name == "generations" {
		expected = collector.boundary.GenerationsProof
	}
	if fileIdentity(info) != expected {
		_ = file.Close()
		return nil, nil, fmt.Errorf("bound source %s identity changed", name)
	}
	return file, info, nil
}

func safeRetentionReason(err error) string {
	if err == nil {
		return ""
	}
	value := err.Error()
	if len(value) > 240 {
		value = value[:240]
	}
	return value
}

func readBoundedJSONAt(directory *os.File, name string, output any) (os.FileInfo, error) {
	fd, err := unix.Openat(int(directory.Fd()), name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), name)
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > maximumStateBytes {
		return nil, errors.Join(err, fmt.Errorf("retention evidence is not a private bounded regular file"))
	}
	decoder := json.NewDecoder(io.LimitReader(file, maximumStateBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("retention evidence has trailing data")
	}
	return info, nil
}

func openPrivateDirectory(path string) (*os.File, os.FileInfo, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		_ = file.Close()
		return nil, nil, errors.Join(err, fmt.Errorf("directory is not private"))
	}
	return file, info, nil
}
