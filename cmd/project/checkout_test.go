package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/projectstorage"
)

func TestCheckoutPurgeDefaultsToDryRunAndPrintsStrongerBlockers(t *testing.T) {
	local := t.TempDir()
	dependencies := checkoutPurgeDependencies{
		Checks:      func(context.Context) ([]projectstorage.CheckoutEvidenceCheck, error) { return nil, nil },
		LoadCatalog: catalogLoader(testProjectCatalog(local)),
		Plan: func(context.Context, string, string, string, projectstorage.CheckoutOptions) (projectstorage.CheckoutPlan, error) {
			return projectstorage.CheckoutPlan{
				Blockers: []projectstorage.Blocker{{Code: "local_only_history", Message: "Local history would be lost."}},
				Candidate: &projectstorage.CheckoutCandidate{
					HeadSHA: strings.Repeat("a", 40), Path: local, Repository: "DotNaos/project-space",
				},
				SchemaVersion: 1,
			}, nil
		},
		Purge: func(context.Context, string, string, string, string, projectstorage.CheckoutOptions) (projectstorage.CheckoutPurgeResult, error) {
			t.Fatal("dry-run invoked purge")
			return projectstorage.CheckoutPurgeResult{}, nil
		},
		SafetyDirs: func() (string, string, string, error) { return local, local, local, nil },
	}
	output := executeProjectsFeatureCommand(
		t, newCheckoutPurgeCommandWithDependencies(dependencies), "--project", "project-space",
	)
	if !strings.Contains(output, "BLOCKED") || !strings.Contains(output, "local_only_history") {
		t.Fatalf("output = %s", output)
	}
}

func TestCheckoutPurgeApplyReturnsVerifiedManifest(t *testing.T) {
	local := t.TempDir()
	head := strings.Repeat("b", 40)
	dependencies := checkoutPurgeDependencies{
		Checks:      func(context.Context) ([]projectstorage.CheckoutEvidenceCheck, error) { return nil, nil },
		LoadCatalog: catalogLoader(testProjectCatalog(local)),
		Plan:        projectstorage.PlanCheckoutPurge,
		Purge: func(context.Context, string, string, string, string, projectstorage.CheckoutOptions) (projectstorage.CheckoutPurgeResult, error) {
			return projectstorage.CheckoutPurgeResult{
				HeadSHA: head, ManifestPath: "/safe/recovery.json", Path: local,
				SchemaVersion: 1, State: "purged", Verified: true,
			}, nil
		},
		SafetyDirs: func() (string, string, string, error) { return local, local, local, nil },
	}
	output := executeProjectsFeatureCommand(
		t, newCheckoutPurgeCommandWithDependencies(dependencies),
		"--project", "project-space", "--expect-head", head, "--apply", "--format", "json",
	)
	result := projectstorage.CheckoutPurgeResult{}
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Verified || result.ManifestPath != "/safe/recovery.json" {
		t.Fatalf("result = %#v", result)
	}
}

func TestGitHubRemoteRepositoryAcceptsHTTPSAndSSHOnly(t *testing.T) {
	for input, want := range map[string]string{
		"https://github.com/DotNaos/project-space.git": "dotnaos/project-space",
		"git@github.com:DotNaos/project-space.git":        "dotnaos/project-space",
		"ssh://git@github.com/DotNaos/project-space.git":  "dotnaos/project-space",
		"https://example.com/DotNaos/project-space.git":   "",
	} {
		if got := githubRemoteRepository(input); got != want {
			t.Fatalf("githubRemoteRepository(%q) = %q, want %q", input, got, want)
		}
	}
	if missing := missingNames("main\nlocal-only\n", "main\n", "HEAD"); len(missing) != 1 || missing[0] != "local-only" {
		t.Fatalf("missing = %#v", missing)
	}
}
