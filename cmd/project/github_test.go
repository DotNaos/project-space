package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestGitHubRepositoryRef(t *testing.T) {
	tests := map[string]string{
		"https://github.com/DotNaos/example":     "DotNaos/example",
		"https://github.com/DotNaos/example.git": "DotNaos/example",
	}
	for input, want := range tests {
		got, err := githubRepositoryRef(input)
		if err != nil {
			t.Fatalf("githubRepositoryRef(%q) returned error: %v", input, err)
		}
		if got != want {
			t.Fatalf("githubRepositoryRef(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestGitHubRepositoryRefRejectsUnsupportedURLs(t *testing.T) {
	if _, err := githubRepositoryRef("https://example.com/DotNaos/example"); err == nil {
		t.Fatal("expected unsupported host error")
	}
	if _, err := githubRepositoryRef("https://github.com/DotNaos"); err == nil {
		t.Fatal("expected unsupported path error")
	}
}

func TestGitHubRepositoryName(t *testing.T) {
	got, err := githubRepositoryName("/tmp/my-app")
	if err != nil {
		t.Fatalf("githubRepositoryName returned error: %v", err)
	}
	if got != "my-app" {
		t.Fatalf("githubRepositoryName = %q, want my-app", got)
	}
}

func TestGitHubRepositoryVisibilityFlag(t *testing.T) {
	tests := map[string]string{
		"":        "--private",
		"private": "--private",
		"public":  "--public",
	}
	for input, want := range tests {
		if got := githubRepositoryVisibilityFlag(input); got != want {
			t.Fatalf("githubRepositoryVisibilityFlag(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestApplyGitHubRulesetsCreatesOrUpdatesByName(t *testing.T) {
	tests := []struct {
		name         string
		existing     string
		wantMethod   string
		wantEndpoint string
	}{
		{
			name:         "create",
			existing:     "[]",
			wantMethod:   "POST",
			wantEndpoint: "repos/DotNaos/example/rulesets",
		},
		{
			name:         "update",
			existing:     `[{"id":41,"name":"Protect default branch"}]`,
			wantMethod:   "PUT",
			wantEndpoint: "repos/DotNaos/example/rulesets/41",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			directory := filepath.Join(root, ".github", "rulesets")
			if err := os.MkdirAll(directory, 0o755); err != nil {
				t.Fatal(err)
			}
			content := []byte(`{
			  "name": "Protect default branch",
			  "target": "branch",
			  "enforcement": "active",
			  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
			  "rules": [{"type": "deletion"}]
			}`)
			if err := os.WriteFile(filepath.Join(directory, "default-branch.json"), content, 0o644); err != nil {
				t.Fatal(err)
			}

			original := runExternalCommand
			defer func() {
				runExternalCommand = original
			}()
			var calls [][]string
			var applied []byte
			runExternalCommand = func(_ string, stdin []byte, name string, args ...string) (string, error) {
				calls = append(calls, append([]string{name}, args...))
				switch len(calls) {
				case 1:
					return "78213692\n", nil
				case 2:
					return test.existing, nil
				case 3:
					applied = append([]byte(nil), stdin...)
					return "{}", nil
				default:
					t.Fatalf("unexpected command: %v", calls[len(calls)-1])
					return "", nil
				}
			}

			count, err := applyGitHubRulesets(root, "DotNaos/example")
			if err != nil {
				t.Fatal(err)
			}
			if count != 1 {
				t.Fatalf("applyGitHubRulesets count = %d, want 1", count)
			}
			wantCall := []string{
				"gh",
				"api",
				"--method",
				test.wantMethod,
				test.wantEndpoint,
				"--input",
				"-",
			}
			if !reflect.DeepEqual(calls[2], wantCall) {
				t.Fatalf("apply command = %v, want %v", calls[2], wantCall)
			}

			var document githubRulesetDocument
			if err := json.Unmarshal(applied, &document); err != nil {
				t.Fatal(err)
			}
			if _, ok := document["rules"]; !ok {
				t.Fatal("ruleset application dropped the rules field")
			}
			var actors []githubRulesetBypassActor
			if err := json.Unmarshal(document["bypass_actors"], &actors); err != nil {
				t.Fatal(err)
			}
			wantActors := []githubRulesetBypassActor{{
				ActorID:    78213692,
				ActorType:  "User",
				BypassMode: "pull_request",
			}}
			if !reflect.DeepEqual(actors, wantActors) {
				t.Fatalf("bypass actors = %#v, want %#v", actors, wantActors)
			}
		})
	}
}

func TestApplyGitHubRulesetsDoesNothingWithoutPolicyFiles(t *testing.T) {
	original := runExternalCommand
	defer func() {
		runExternalCommand = original
	}()
	runExternalCommand = func(_ string, _ []byte, name string, args ...string) (string, error) {
		t.Fatalf("unexpected command: %s %v", name, args)
		return "", nil
	}

	count, err := applyGitHubRulesets(t.TempDir(), "DotNaos/example")
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("applyGitHubRulesets count = %d, want 0", count)
	}
}
