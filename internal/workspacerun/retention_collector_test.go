//go:build !windows

package workspacerun

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRetentionCollectorRequiresAnExclusiveOwnerBoundary(t *testing.T) {
	source, target := t.TempDir(), t.TempDir()
	if err := os.Chmod(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := NewRetentionCollector(RetentionOptions{SourceRoot: source, CollectorRoot: target})
	if err == nil || !strings.Contains(err.Error(), "collector must run as root") {
		t.Fatalf("same-owner collector boundary error = %v", err)
	}
}

func TestRetentionCollectorReclaimsExactGenerationAndSnapshotsWithoutTouchingCheckout(t *testing.T) {
	manager, workspace, record := retainedRuntimeFixture(t)
	checkoutMarker := filepath.Join(workspace, "checkout-must-survive.txt")
	if err := os.WriteFile(checkoutMarker, []byte("keep\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	collector := testRetentionCollector(t, manager.store.root)
	status, err := collector.Status()
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Entries) != 1 || status.Entries[0].Status != RetentionEligible || status.Entries[0].StateSnapshots == 0 {
		t.Fatalf("retention status = %#v", status)
	}
	report, err := collector.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Entries) != 1 || report.Entries[0].Status != RetentionReclaimed || report.ReclaimedBytes == 0 {
		t.Fatalf("retention report = %#v", report)
	}
	if _, err := os.Lstat(filepath.Join(manager.store.root, "generations", record.GenerationArchive)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("retained generation still present: %v", err)
	}
	if body, err := os.ReadFile(checkoutMarker); err != nil || string(body) != "keep\n" {
		t.Fatalf("checkout changed: body=%q err=%v", body, err)
	}
	if _, err := os.Stat(filepath.Join(workspace, manifestPath)); err != nil {
		t.Fatalf("checkout manifest changed: %v", err)
	}
	assertNoMatchingSnapshots(t, manager.store.root, record)
}

func TestRetentionCollectorResumesAfterCrashWithClaimedEvidence(t *testing.T) {
	manager, _, record := retainedRuntimeFixture(t)
	collector := testRetentionCollector(t, manager.store.root)
	collector.afterClaim = func() error { return errors.New("fixture crash after claim") }
	report, err := collector.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Entries) != 1 || report.Entries[0].Status != RetentionInvalid {
		t.Fatalf("interrupted report = %#v", report)
	}
	if _, err := os.Stat(filepath.Join(collector.options.CollectorRoot, "staging")); err != nil {
		t.Fatal(err)
	}
	resumed, err := newRetentionCollector(collector.options, true)
	if err != nil {
		t.Fatal(err)
	}
	resumed.now = collector.now
	report, err = resumed.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Entries) == 0 || report.Entries[0].Status != RetentionReclaimed {
		t.Fatalf("resumed report = %#v", report)
	}
	if _, ok, err := resumed.readReceipt(record.WorkspaceID, record.Generation); err != nil || !ok {
		t.Fatalf("terminal receipt exists=%v err=%v", ok, err)
	}
}

func TestRetentionCollectorResumesAtPreparedAndDeletedCutpoints(t *testing.T) {
	for _, cutpoint := range []string{"prepared", "deleted"} {
		t.Run(cutpoint, func(t *testing.T) {
			manager, _, record := retainedRuntimeFixture(t)
			collector := testRetentionCollector(t, manager.store.root)
			if cutpoint == "prepared" {
				collector.afterPrepare = func() error { return errors.New("fixture crash after prepared intent") }
			} else {
				collector.afterDelete = func() error { return errors.New("fixture crash after exclusive deletion") }
			}
			if report, err := collector.Collect(); err != nil || len(report.Entries) != 1 || report.Entries[0].Status != RetentionInvalid {
				t.Fatalf("interrupted %s report=%#v err=%v", cutpoint, report, err)
			}
			resumed, err := newRetentionCollector(collector.options, true)
			if err != nil {
				t.Fatal(err)
			}
			resumed.now = collector.now
			report, err := resumed.Collect()
			if err != nil {
				t.Fatal(err)
			}
			if len(report.Entries) != 1 || report.Entries[0].Status != RetentionReclaimed {
				t.Fatalf("resumed %s report=%#v", cutpoint, report)
			}
			if _, ok, err := resumed.readReceipt(record.WorkspaceID, record.Generation); err != nil || !ok {
				t.Fatalf("terminal receipt after %s exists=%v err=%v", cutpoint, ok, err)
			}
		})
	}
}

func TestRetentionCollectorRefusesArchiveReplacementWithoutDeletingEitherInode(t *testing.T) {
	manager, _, record := retainedRuntimeFixture(t)
	collector := testRetentionCollector(t, manager.store.root)
	candidates, _, err := collector.scanCandidates(nil)
	if err != nil || len(candidates) != 1 {
		t.Fatalf("scan candidates=%d err=%v", len(candidates), err)
	}
	archive := filepath.Join(manager.store.root, "generations", record.GenerationArchive)
	owned := archive + ".owned"
	if err := os.Rename(archive, owned); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(archive, 0o700); err != nil {
		t.Fatal(err)
	}
	foreignMarker := filepath.Join(archive, "foreign")
	if err := os.WriteFile(foreignMarker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := collector.reclaim(candidates[0]); err == nil {
		t.Fatal("replacement archive was reclaimed")
	}
	for _, marker := range []string{foreignMarker, filepath.Join(owned, "runtime.log")} {
		if _, err := os.Stat(marker); err != nil {
			t.Fatalf("evidence was deleted at %s: %v", marker, err)
		}
	}
}

func TestRetentionCollectorDoesNotDeleteRenameCutpointReplacement(t *testing.T) {
	manager, _, record := retainedRuntimeFixture(t)
	collector := testRetentionCollector(t, manager.store.root)
	archive := filepath.Join(manager.store.root, "generations", record.GenerationArchive)
	owned := archive + ".owned"
	foreignMarker := filepath.Join(archive, "foreign")
	collector.beforeClaimRename = func() error {
		if err := os.Rename(archive, owned); err != nil {
			return err
		}
		if err := os.Mkdir(archive, 0o700); err != nil {
			return err
		}
		return os.WriteFile(foreignMarker, []byte("keep"), 0o600)
	}
	report, err := collector.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Entries) != 1 || report.Entries[0].Status != RetentionInvalid || report.ReclaimedBytes != 0 {
		t.Fatalf("rename-cutpoint report = %#v", report)
	}
	if _, err := os.Stat(filepath.Join(owned, "runtime.log")); err != nil {
		t.Fatalf("owned generation was deleted: %v", err)
	}
	staged, err := os.ReadDir(filepath.Join(collector.options.CollectorRoot, "staging"))
	if err != nil || len(staged) != 1 {
		t.Fatalf("replacement was not retained safely: staged=%d err=%v", len(staged), err)
	}
	marker := filepath.Join(collector.options.CollectorRoot, "staging", staged[0].Name(), "foreign")
	if body, err := os.ReadFile(marker); err != nil || string(body) != "keep" {
		t.Fatalf("replacement content changed: body=%q err=%v", body, err)
	}
}

func TestRetentionCollectorDoesNotDeleteChildInjectedBeforeOwnershipTransfer(t *testing.T) {
	manager, _, _ := retainedRuntimeFixture(t)
	collector := testRetentionCollector(t, manager.store.root)
	collector.afterClaimTransfer = func(intent retentionIntent) error {
		path := filepath.Join(collector.options.CollectorRoot, "staging", intent.StageName, "injected")
		return os.WriteFile(path, []byte("keep"), 0o600)
	}
	report, err := collector.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Entries) != 1 || report.Entries[0].Status != RetentionInvalid ||
		!strings.Contains(report.Entries[0].Reason, "contents changed") || report.ReclaimedBytes != 0 {
		t.Fatalf("child-injection report = %#v", report)
	}
	entries, err := os.ReadDir(filepath.Join(collector.options.CollectorRoot, "staging"))
	if err != nil || len(entries) == 0 {
		t.Fatalf("injected evidence was deleted: entries=%d err=%v", len(entries), err)
	}
}

func TestRetentionCollectorRefusesForeignHardlinkWithZeroDeletion(t *testing.T) {
	manager, _, record := retainedRuntimeFixture(t)
	archive := filepath.Join(manager.store.root, "generations", record.GenerationArchive)
	foreign := filepath.Join(t.TempDir(), "foreign")
	if err := os.WriteFile(foreign, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(foreign, filepath.Join(archive, "hardlink")); err != nil {
		t.Fatal(err)
	}
	collector := testRetentionCollector(t, manager.store.root)
	report, err := collector.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Entries) != 1 || report.Entries[0].Status != RetentionInvalid || report.ReclaimedBytes != 0 {
		t.Fatalf("hardlink report = %#v", report)
	}
	if body, err := os.ReadFile(foreign); err != nil || string(body) != "keep" {
		t.Fatalf("foreign hardlink target changed: body=%q err=%v", body, err)
	}
	if _, err := os.Stat(archive); err != nil {
		t.Fatalf("owned archive moved or deleted: %v", err)
	}
}

func TestRetentionCollectorRefusesActiveGenerationReappearanceAfterClaim(t *testing.T) {
	manager, _, record := retainedRuntimeFixture(t)
	collector := testRetentionCollector(t, manager.store.root)
	active := manager.store.generationHome(record.WorkspaceID, record.Generation)
	collector.afterClaim = func() error { return os.Mkdir(active, 0o700) }
	report, err := collector.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Entries) != 1 || report.Entries[0].Status != RetentionInvalid || report.ReclaimedBytes != 0 {
		t.Fatalf("active reappearance report = %#v", report)
	}
	entries, err := os.ReadDir(filepath.Join(collector.options.CollectorRoot, "staging"))
	if err != nil || len(entries) == 0 {
		t.Fatalf("claimed evidence was deleted: entries=%d err=%v", len(entries), err)
	}
}

func TestRetentionCollectorRefusesBoundSourceNamespaceReplacement(t *testing.T) {
	manager, _, _ := retainedRuntimeFixture(t)
	collector := testRetentionCollector(t, manager.store.root)
	states := filepath.Join(manager.store.root, "states")
	original := states + ".original"
	if err := os.Rename(states, original); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(states, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := collector.Collect(); err == nil || !strings.Contains(err.Error(), "namespace identity changed") {
		t.Fatalf("replaced source namespace error = %v", err)
	}
	if entries, err := os.ReadDir(filepath.Join(collector.options.CollectorRoot, "receipts")); err != nil || len(entries) != 0 {
		t.Fatalf("replacement produced receipts: entries=%d err=%v", len(entries), err)
	}
}

func TestRetentionCollectorRefusesTerminalTombstoneReplacementAfterClaim(t *testing.T) {
	manager, _, record := retainedRuntimeFixture(t)
	collector := testRetentionCollector(t, manager.store.root)
	statePath := manager.store.statePath(record.WorkspaceID)
	collector.afterClaim = func() error {
		body, err := os.ReadFile(statePath)
		if err != nil {
			return err
		}
		if err := os.Rename(statePath, statePath+".replaced"); err != nil {
			return err
		}
		return os.WriteFile(statePath, body, 0o600)
	}
	report, err := collector.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Entries) != 1 || report.Entries[0].Status != RetentionInvalid || !strings.Contains(report.Entries[0].Reason, "tombstone identity changed") {
		t.Fatalf("tombstone replacement report = %#v", report)
	}
	if entries, err := os.ReadDir(filepath.Join(collector.options.CollectorRoot, "staging")); err != nil || len(entries) == 0 {
		t.Fatalf("claimed evidence was deleted: entries=%d err=%v", len(entries), err)
	}
}

func retainedRuntimeFixture(t *testing.T) (*Manager, string, runtimeRecord) {
	t.Helper()
	manager, _, workspace := newRuntimeTestManager(t)
	started, err := manager.Start(context.Background(), workspace, OperationOptions{Mode: ModeProcess}, Streams{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Stop(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation}, Streams{}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Clean(context.Background(), workspace, OperationOptions{ExpectedGeneration: started.Generation}); err != nil {
		t.Fatal(err)
	}
	identity, err := manager.identity.Resolve(context.Background(), workspace)
	if err != nil {
		t.Fatal(err)
	}
	record, exists, err := manager.store.load(identity)
	if err != nil || !exists || !record.GenerationRemoved {
		t.Fatalf("terminal record=%#v exists=%v err=%v", record, exists, err)
	}
	return manager, workspace, record
}

func testRetentionCollector(t *testing.T, sourceRoot string) *RetentionCollector {
	t.Helper()
	fixtureNow := time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC)
	archives, err := os.ReadDir(filepath.Join(sourceRoot, "generations"))
	if err != nil {
		t.Fatal(err)
	}
	for _, archive := range archives {
		if !archive.IsDir() || !strings.HasPrefix(archive.Name(), ".retained-") {
			continue
		}
		archiveTime := fixtureNow.Add(-time.Hour)
		if err := os.Chtimes(filepath.Join(sourceRoot, "generations", archive.Name()), archiveTime, archiveTime); err != nil {
			t.Fatal(err)
		}
	}
	collectorRoot := t.TempDir()
	if err := os.Chmod(collectorRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	collector, err := newRetentionCollector(RetentionOptions{SourceRoot: sourceRoot, CollectorRoot: collectorRoot, MinimumAge: time.Nanosecond, MaximumBytes: 1 << 30}, true)
	if err != nil {
		t.Fatal(err)
	}
	collector.now = func() time.Time { return fixtureNow }
	return collector
}

func assertNoMatchingSnapshots(t *testing.T, root string, terminal runtimeRecord) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(root, "states"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if retainedStateNamePattern.MatchString(entry.Name()) {
			body, err := os.ReadFile(filepath.Join(root, "states", entry.Name()))
			if err == nil && strings.Contains(string(body), terminal.Generation) {
				t.Fatalf("matching retained state snapshot remains: %s", entry.Name())
			}
		}
	}
}
