package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/projectstorage"
)

func TestStorageAuditReportsRemoteAndLocalProjects(t *testing.T) {
	local := t.TempDir()
	dependencies := storageCommandDependencies{
		Audit: func(_ context.Context, projectID, repository, path string, _ projectstorage.Options) (projectstorage.Report, error) {
			return projectstorage.Report{
				CheckedAt: "2026-08-15T10:00:00Z", Complete: true, MainBytes: 10,
				Path: path, ProjectID: projectID, Repository: repository,
				SchemaVersion: 1, TotalBytes: 40, WorktreeBytes: 30, Worktrees: []projectstorage.Entry{},
			}, nil
		},
		LoadCatalog: catalogLoader(testProjectCatalog(local)),
		Now:         func() time.Time { return time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC) },
	}
	output := executeProjectsFeatureCommand(t, newStorageCommandWithDependencies(dependencies), "audit", "--format", "json")
	var result storageAuditResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Complete || result.TotalBytes != 40 || len(result.Projects) != 2 {
		t.Fatalf("result = %#v", result)
	}
	if result.Projects[0].Repository != "DotNaos/project-space" || result.Projects[0].Storage == nil {
		t.Fatalf("local project = %#v", result.Projects[0])
	}
	if result.Projects[1].LocalAvailable || result.Projects[1].Storage != nil {
		t.Fatalf("remote project = %#v", result.Projects[1])
	}

	human := executeProjectsFeatureCommand(t, newStorageCommandWithDependencies(dependencies), "audit")
	for _, value := range []string{"PROJECT", "MAIN", "WORKTREES", "DotNaos/project-space", "remote only", "40 B"} {
		if !strings.Contains(human, value) {
			t.Fatalf("human output missing %q:\n%s", value, human)
		}
	}
}

func TestStorageAuditPreservesPartialEvidence(t *testing.T) {
	local := t.TempDir()
	dependencies := storageCommandDependencies{
		Audit: func(context.Context, string, string, string, projectstorage.Options) (projectstorage.Report, error) {
			return projectstorage.Report{}, errors.New("measurement denied")
		},
		LoadCatalog: catalogLoader(testProjectCatalog(local)),
	}
	output := executeProjectsFeatureCommand(t, newStorageCommandWithDependencies(dependencies), "audit", "--project", "project-space", "--format", "json")
	var result storageAuditResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if result.Complete || len(result.Projects) != 1 || result.Projects[0].Error != "measurement denied" {
		t.Fatalf("result = %#v", result)
	}
}
