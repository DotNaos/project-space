package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/selfupdate"
)

func TestProjectUpdateNoticeShowsFreshAvailableRelease(t *testing.T) {
	now := time.Date(2026, time.August, 12, 20, 0, 0, 0, time.UTC)
	directory := t.TempDir()
	cache := projectUpdateNoticeCache{Directory: directory, Now: func() time.Time { return now }}
	if err := cache.Write(projectUpdateNoticeRecord{
		SchemaVersion:  projectUpdateNoticeSchema,
		CheckedAt:      now.Add(-time.Hour),
		CurrentVersion: "0.20.0",
		TargetVersion:  "0.21.10",
		State:          selfupdate.StateUpdateAvailable,
	}); err != nil {
		t.Fatal(err)
	}
	started := 0
	output := &bytes.Buffer{}
	err := runProjectUpdateNotice(nil, output, projectUpdateNoticeDependencies{
		CacheDirectory: func() string { return directory },
		CurrentVersion: func() string { return "0.20.0" },
		Environment:    func(string) string { return "" },
		Now:            func() time.Time { return now },
		StartRefresh:   func() error { started++; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if started != 0 || output.String() != "Project 0.21.10 is available (current: 0.20.0). Run `project self-update` to install it.\n" {
		t.Fatalf("output = %q, refreshes = %d", output, started)
	}
}

func TestProjectUpdateNoticeRefreshesStaleCacheOnce(t *testing.T) {
	now := time.Date(2026, time.August, 12, 20, 0, 0, 0, time.UTC)
	directory := t.TempDir()
	started := 0
	dependencies := projectUpdateNoticeDependencies{
		CacheDirectory: func() string { return directory },
		CurrentVersion: func() string { return "0.20.0" },
		Environment:    func(string) string { return "" },
		Now:            func() time.Time { return now },
		StartRefresh:   func() error { started++; return nil },
	}
	for range 2 {
		if err := runProjectUpdateNotice(nil, &bytes.Buffer{}, dependencies); err != nil {
			t.Fatal(err)
		}
	}
	if started != 1 {
		t.Fatalf("refreshes = %d", started)
	}
	marker := filepath.Join(directory, projectUpdateNoticeRefreshMarker)
	if info, err := os.Lstat(marker); err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("refresh marker info = %#v, error = %v", info, err)
	}
}

func TestProjectUpdateNoticeDoesNotAffectExcludedOrAutomatedCommands(t *testing.T) {
	tests := []struct {
		name        string
		arguments   []string
		environment string
	}{
		{name: "self update", arguments: []string{"self-update"}},
		{name: "completion", arguments: []string{"completion", "zsh"}},
		{name: "hidden worker", arguments: []string{projectUpdateNoticeRefreshCommand}},
		{name: "help", arguments: []string{"help", "status"}},
		{name: "long help flag", arguments: []string{"status", "--help"}},
		{name: "short help flag", arguments: []string{"-h"}},
		{name: "opt out one", arguments: []string{"status"}, environment: "1"},
		{name: "opt out true", arguments: []string{"status"}, environment: "true"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			started := 0
			err := runProjectUpdateNotice(test.arguments, &bytes.Buffer{}, projectUpdateNoticeDependencies{
				CacheDirectory: func() string { return t.TempDir() },
				CurrentVersion: func() string { return "0.20.0" },
				Environment:    func(string) string { return test.environment },
				Now:            time.Now,
				StartRefresh:   func() error { started++; return nil },
			})
			if err != nil || started != 0 {
				t.Fatalf("error = %v, refreshes = %d", err, started)
			}
		})
	}
}

func TestProjectUpdateNoticeSuppressesCurrentAndRecentFailureStates(t *testing.T) {
	now := time.Date(2026, time.August, 12, 20, 0, 0, 0, time.UTC)
	for _, record := range []projectUpdateNoticeRecord{
		{
			SchemaVersion: projectUpdateNoticeSchema, CheckedAt: now,
			CurrentVersion: "0.20.0", TargetVersion: "0.20.0",
			State: selfupdate.StateCurrent,
		},
		{
			SchemaVersion: projectUpdateNoticeSchema, CheckedAt: now.Add(-time.Minute),
			CurrentVersion: "0.20.0", State: selfupdate.StateVerificationFailed,
		},
		{
			SchemaVersion: projectUpdateNoticeSchema, CheckedAt: now,
			CurrentVersion: "0.20.0", TargetVersion: "0.21.10",
			State: selfupdate.StateUnsupportedSource,
		},
	} {
		directory := t.TempDir()
		cache := projectUpdateNoticeCache{Directory: directory, Now: func() time.Time { return now }}
		if err := cache.Write(record); err != nil {
			t.Fatal(err)
		}
		started := 0
		output := &bytes.Buffer{}
		if err := runProjectUpdateNotice([]string{"status"}, output, projectUpdateNoticeDependencies{
			CacheDirectory: func() string { return directory },
			CurrentVersion: func() string { return "0.20.0" },
			Environment:    func(string) string { return "" },
			Now:            func() time.Time { return now },
			StartRefresh:   func() error { started++; return nil },
		}); err != nil {
			t.Fatal(err)
		}
		if output.Len() != 0 || started != 0 {
			t.Fatalf("record = %#v, output = %q, refreshes = %d", record, output, started)
		}
	}
}

func TestProjectUpdateNoticeRejectsUnsafeOrInvalidCache(t *testing.T) {
	now := time.Date(2026, time.August, 12, 20, 0, 0, 0, time.UTC)
	directory := t.TempDir()
	path := filepath.Join(directory, projectUpdateNoticeCacheFile)
	if err := os.WriteFile(path, []byte(`{"schemaVersion":1,"checkedAt":"2026-08-12T20:00:00Z","currentVersion":"0.20.0","targetVersion":"bad\nversion","state":"update-available"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	started := 0
	output := &bytes.Buffer{}
	if err := runProjectUpdateNotice([]string{"status"}, output, projectUpdateNoticeDependencies{
		CacheDirectory: func() string { return directory },
		CurrentVersion: func() string { return "0.20.0" },
		Environment:    func(string) string { return "" },
		Now:            func() time.Time { return now },
		StartRefresh:   func() error { started++; return nil },
	}); err != nil {
		t.Fatal(err)
	}
	if output.Len() != 0 || started != 1 {
		t.Fatalf("output = %q, refreshes = %d", output, started)
	}
}

func TestRefreshProjectUpdateNoticeCachesPlanAndRemovesMarker(t *testing.T) {
	now := time.Date(2026, time.August, 12, 20, 0, 0, 0, time.UTC)
	directory := t.TempDir()
	cache := projectUpdateNoticeCache{Directory: directory, Now: func() time.Time { return now }}
	if started, err := cache.BeginRefresh(); err != nil || !started {
		t.Fatalf("begin refresh = %t, error = %v", started, err)
	}
	service := &fakeSelfUpdateService{plan: availableSelfUpdatePlan()}
	if err := refreshProjectUpdateNoticeWithDependencies(context.Background(), projectUpdateNoticeRefreshDependencies{
		CacheDirectory: func() string { return directory },
		CurrentVersion: func() string { return "0.4.7" },
		LoadService:    func() (selfUpdateService, error) { return service, nil },
		Now:            func() time.Time { return now },
	}); err != nil {
		t.Fatal(err)
	}
	record, fresh := cache.Read("0.4.7")
	if !fresh || record.State != selfupdate.StateUpdateAvailable || record.TargetVersion != "0.4.8" {
		t.Fatalf("record = %#v, fresh = %t", record, fresh)
	}
	if _, err := os.Lstat(filepath.Join(directory, projectUpdateNoticeRefreshMarker)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("refresh marker remains: %v", err)
	}
}

func TestRefreshProjectUpdateNoticeCachesFailuresForShortRetry(t *testing.T) {
	now := time.Date(2026, time.August, 12, 20, 0, 0, 0, time.UTC)
	for name, planErr := range map[string]error{
		"offline":      errors.New("offline"),
		"timeout":      context.DeadlineExceeded,
		"malformed":    errors.New("malformed release manifest"),
		"unsigned":     errors.New("bad signature"),
		"expired":      errors.New("release manifest expired"),
		"downgrade":    errors.New("approved release would downgrade"),
		"incompatible": errors.New("release artifact is incompatible"),
	} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			service := &fakeSelfUpdateService{
				plan: selfupdate.Plan{Result: selfupdate.Result{
					CurrentVersion: "0.4.7", InstallSource: selfupdate.InstallSourceManaged,
				}},
				planErr: planErr,
			}
			if err := refreshProjectUpdateNoticeWithDependencies(context.Background(), projectUpdateNoticeRefreshDependencies{
				CacheDirectory: func() string { return directory },
				CurrentVersion: func() string { return "0.4.7" },
				LoadService:    func() (selfUpdateService, error) { return service, nil },
				Now:            func() time.Time { return now },
			}); err != nil {
				t.Fatal(err)
			}
			cache := projectUpdateNoticeCache{Directory: directory, Now: func() time.Time { return now.Add(14 * time.Minute) }}
			record, fresh := cache.Read("0.4.7")
			if !fresh || record.State != selfupdate.StateVerificationFailed {
				t.Fatalf("record = %#v, fresh = %t", record, fresh)
			}
			cache.Now = func() time.Time { return now.Add(16 * time.Minute) }
			if _, fresh := cache.Read("0.4.7"); fresh {
				t.Fatal("failed refresh remained fresh beyond retry interval")
			}
		})
	}
}

func TestRefreshProjectUpdateNoticeRejectsMismatchedCurrentVersion(t *testing.T) {
	now := time.Date(2026, time.August, 12, 20, 0, 0, 0, time.UTC)
	directory := t.TempDir()
	service := &fakeSelfUpdateService{plan: availableSelfUpdatePlan()}
	if err := refreshProjectUpdateNoticeWithDependencies(context.Background(), projectUpdateNoticeRefreshDependencies{
		CacheDirectory: func() string { return directory },
		CurrentVersion: func() string { return "9.9.9" },
		LoadService:    func() (selfUpdateService, error) { return service, nil },
		Now:            func() time.Time { return now },
	}); err != nil {
		t.Fatal(err)
	}
	cache := projectUpdateNoticeCache{Directory: directory, Now: func() time.Time { return now }}
	record, fresh := cache.Read("9.9.9")
	if !fresh || record.State != selfupdate.StateVerificationFailed || record.TargetVersion != "" {
		t.Fatalf("record = %#v, fresh = %t", record, fresh)
	}
}

func TestProjectUpdateNoticeCacheIsPrivate(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "nested", "cache")
	now := time.Date(2026, time.August, 12, 20, 0, 0, 0, time.UTC)
	cache := projectUpdateNoticeCache{Directory: directory, Now: func() time.Time { return now }}
	if err := cache.Write(projectUpdateNoticeRecord{
		SchemaVersion: projectUpdateNoticeSchema, CheckedAt: now,
		CurrentVersion: "1.2.3", TargetVersion: "1.2.3",
		State: selfupdate.StateCurrent,
	}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{directory, filepath.Join(directory, projectUpdateNoticeCacheFile)} {
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("%s permissions = %o", path, info.Mode().Perm())
		}
	}
}

func TestProjectUpdateNoticeVersionValidation(t *testing.T) {
	for _, invalid := range []string{"", "dev", "1.2", "01.2.3", "1.2.3-beta", "1.2.3\nmalicious"} {
		if projectUpdateNoticeVersionValid(invalid) {
			t.Fatalf("accepted invalid version %q", invalid)
		}
	}
	if !projectUpdateNoticeVersionNewer("0.20.0", "0.21.0") ||
		projectUpdateNoticeVersionNewer("0.21.0", "0.20.9") ||
		projectUpdateNoticeVersionNewer("0.21.0", "0.21.0") {
		t.Fatal("version ordering is invalid")
	}
}

func TestProjectUpdateNoticeStartFailureReleasesMarker(t *testing.T) {
	directory := t.TempDir()
	err := runProjectUpdateNotice([]string{"status"}, &bytes.Buffer{}, projectUpdateNoticeDependencies{
		CacheDirectory: func() string { return directory },
		CurrentVersion: func() string { return "0.20.0" },
		Environment:    func(string) string { return "" },
		Now:            time.Now,
		StartRefresh:   func() error { return errors.New("cannot start") },
	})
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("cache entries remain: %s", strings.Join(names, ", "))
	}
}

func TestProjectUpdateNoticeStaleRefreshRemovesTemporaryFiles(t *testing.T) {
	directory := t.TempDir()
	marker := filepath.Join(directory, projectUpdateNoticeRefreshMarker)
	temporary := filepath.Join(directory, ".update-notice-abandoned.tmp")
	if err := os.WriteFile(marker, []byte("stale\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(temporary, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	stale := time.Now().Add(-projectUpdateNoticeMarkerLifetime - time.Minute)
	if err := os.Chtimes(marker, stale, stale); err != nil {
		t.Fatal(err)
	}
	cache := projectUpdateNoticeCache{Directory: directory, Now: time.Now}
	started, err := cache.BeginRefresh()
	if err != nil || !started {
		t.Fatalf("begin refresh = %t, error = %v", started, err)
	}
	if _, err := os.Lstat(temporary); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("abandoned temporary file remains: %v", err)
	}
	if err := cache.EndRefresh(); err != nil {
		t.Fatal(err)
	}
}
