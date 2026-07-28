package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/projectcatalog"
	"github.com/DotNaos/project-space/internal/terminallauncher"
	"github.com/spf13/cobra"
)

type recordingTerminalLauncher struct {
	directory string
	result    terminallauncher.Result
}

func (launcher *recordingTerminalLauncher) Open(
	_ context.Context,
	directory string,
) (terminallauncher.Result, error) {
	launcher.directory = directory
	return launcher.result, nil
}

func TestProjectListDistinguishesAccountKnownAndLocallyAvailable(t *testing.T) {
	local := t.TempDir()
	canonicalLocal, err := filepath.EvalSymlinks(local)
	if err != nil {
		t.Fatal(err)
	}
	dependencies := projectCommandsDependencies{
		LoadCatalog: catalogLoader(testProjectCatalog(local)),
		Launcher:    &recordingTerminalLauncher{},
	}
	command := newProjectListCommandWithDependencies(dependencies)
	output := executeProjectsFeatureCommand(t, command, "--format", "json")
	var result projectListResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("decode: %v\n%s", err, output)
	}
	if result.SchemaVersion != 1 || len(result.Projects) != 2 {
		t.Fatalf("result = %#v", result)
	}
	if result.Projects[0].Repository != "DotNaos/design-space" ||
		result.Projects[0].LocalAvailable ||
		result.Projects[0].LocalPath != nil {
		t.Fatalf("remote project = %#v", result.Projects[0])
	}
	if !result.Projects[1].LocalAvailable ||
		result.Projects[1].LocalPath == nil ||
		*result.Projects[1].LocalPath != canonicalLocal {
		t.Fatalf("local project = %#v", result.Projects[1])
	}

	human := executeProjectsFeatureCommand(
		t,
		newProjectListCommandWithDependencies(dependencies),
	)
	for _, value := range []string{
		"NAME",
		"REPOSITORY",
		"LOCAL",
		"design-space",
		"no",
		"project-space",
		"yes",
		canonicalLocal,
	} {
		if !strings.Contains(human, value) {
			t.Fatalf("human output missing %q:\n%s", value, human)
		}
	}
}

func TestProjectPathPrintsOnlyCanonicalPath(t *testing.T) {
	root := t.TempDir()
	realDirectory := filepath.Join(root, "real")
	if err := os.Mkdir(realDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(realDirectory, link); err != nil {
		t.Fatal(err)
	}
	dependencies := projectCommandsDependencies{
		LoadCatalog: catalogLoader(testProjectCatalog(link)),
		Launcher:    &recordingTerminalLauncher{},
	}
	output := executeProjectsFeatureCommand(
		t,
		newProjectPathCommandWithDependencies(dependencies),
		"project-space",
	)
	canonicalReal, err := filepath.EvalSymlinks(realDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if output != canonicalReal+"\n" {
		t.Fatalf("stdout = %q, want only %q", output, canonicalReal+"\n")
	}
}

func TestProjectSelectorsSupportStableIDRepositoryAndRejectAmbiguousNames(t *testing.T) {
	catalog := testProjectCatalog(t.TempDir())
	catalog.Projects = append(catalog.Projects, projectcatalog.Project{
		DisplayName:     "project-space",
		ID:              "github:3",
		LocalCandidates: []projectcatalog.LocalCandidate{},
		Repository:      "Other/project-space",
	})
	dependencies := projectCommandsDependencies{
		LoadCatalog: catalogLoader(catalog),
		Launcher:    &recordingTerminalLauncher{},
	}
	for _, selector := range []string{"github:2", "dotnaos/PROJECT-space"} {
		output := executeProjectsFeatureCommand(
			t,
			newProjectPathCommandWithDependencies(dependencies),
			selector,
		)
		if !strings.HasSuffix(output, "\n") {
			t.Fatalf("%s output = %q", selector, output)
		}
	}

	command := newProjectPathCommandWithDependencies(dependencies)
	command.SetArgs([]string{"project-space"})
	err := command.Execute()
	if err == nil ||
		!strings.Contains(err.Error(), "ambiguous") ||
		!strings.Contains(err.Error(), "DotNaos/project-space (github:2)") ||
		!strings.Contains(err.Error(), "Other/project-space (github:3)") {
		t.Fatalf("ambiguity error = %v", err)
	}
}

func TestProjectPathRejectsRemoteMissingAndMultipleLocalCheckouts(t *testing.T) {
	first := t.TempDir()
	second := t.TempDir()
	catalog := testProjectCatalog(first)
	catalog.Projects[1].LocalCandidates = []projectcatalog.LocalCandidate{
		{Path: first, ProjectID: "first"},
		{Path: second, ProjectID: "second"},
	}
	dependencies := projectCommandsDependencies{
		LoadCatalog: catalogLoader(catalog),
		Launcher:    &recordingTerminalLauncher{},
	}
	command := newProjectPathCommandWithDependencies(dependencies)
	command.SetArgs([]string{"project-space"})
	if err := command.Execute(); err == nil ||
		!strings.Contains(err.Error(), "multiple local checkouts") ||
		!strings.Contains(err.Error(), first) ||
		!strings.Contains(err.Error(), second) {
		t.Fatalf("multiple error = %v", err)
	}

	command = newProjectPathCommandWithDependencies(dependencies)
	command.SetArgs([]string{"design-space"})
	if err := command.Execute(); err == nil ||
		!strings.Contains(err.Error(), "not checked out locally") {
		t.Fatalf("remote error = %v", err)
	}
}

func TestProjectOpenLaunchesValidatedDirectoryAndReportsSelection(t *testing.T) {
	local := t.TempDir()
	canonicalLocal, err := filepath.EvalSymlinks(local)
	if err != nil {
		t.Fatal(err)
	}
	launcher := &recordingTerminalLauncher{
		result: terminallauncher.Result{
			Launcher:  "Ghostty",
			Selection: terminallauncher.SelectionSystemDefault,
		},
	}
	dependencies := projectCommandsDependencies{
		LoadCatalog: catalogLoader(testProjectCatalog(local)),
		Launcher:    launcher,
	}
	output := executeProjectsFeatureCommand(
		t,
		newProjectOpenCommandWithDependencies(dependencies),
		"project-space",
		"--format",
		"json",
	)
	if launcher.directory != canonicalLocal {
		t.Fatalf("opened directory = %q", launcher.directory)
	}
	var result projectOpenResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if result.Launcher != "Ghostty" ||
		result.Selection != terminallauncher.SelectionSystemDefault ||
		result.Path != canonicalLocal {
		t.Fatalf("result = %#v", result)
	}
}

func TestProjectCompletionUsesUnambiguousSelectorsAndMarksCachedFallback(t *testing.T) {
	local := t.TempDir()
	catalog := testProjectCatalog(local)
	catalog.Projects = append(catalog.Projects, projectcatalog.Project{
		DisplayName:     "project-space",
		ID:              "github:3",
		LocalCandidates: []projectcatalog.LocalCandidate{},
		Repository:      "Other/project-space",
	})
	dependencies := projectCommandsDependencies{
		LoadCatalog: func(context.Context, bool) (projectCatalogLoad, error) {
			return projectCatalogLoad{Cached: true, Catalog: catalog}, nil
		},
		Launcher: &recordingTerminalLauncher{},
	}
	command := newProjectOpenCommandWithDependencies(dependencies)
	values, directive := command.ValidArgsFunction(command, nil, "")
	if directive != cobra.ShellCompDirectiveNoFileComp {
		t.Fatalf("directive = %v", directive)
	}
	joined := strings.Join(values, "\n")
	for _, value := range []string{
		"design-space\tDotNaos/design-space",
		"DotNaos/project-space\tDotNaos/project-space",
		"Other/project-space\tOther/project-space",
		"cached; local availability unverified",
	} {
		if !strings.Contains(joined, value) {
			t.Fatalf("completion missing %q:\n%s", value, joined)
		}
	}
}

func TestProjectCompletionFailsQuietly(t *testing.T) {
	command := newProjectPathCommandWithDependencies(projectCommandsDependencies{
		LoadCatalog: func(context.Context, bool) (projectCatalogLoad, error) {
			return projectCatalogLoad{}, errors.New("offline")
		},
		Launcher: &recordingTerminalLauncher{},
	})
	values, directive := command.ValidArgsFunction(command, nil, "")
	if len(values) != 0 || directive != cobra.ShellCompDirectiveNoFileComp {
		t.Fatalf("completion = %q, %v", values, directive)
	}
}

func catalogLoader(catalog projectcatalog.Catalog) projectCatalogLoader {
	return func(context.Context, bool) (projectCatalogLoad, error) {
		return projectCatalogLoad{Catalog: catalog}, nil
	}
}

func testProjectCatalog(local string) projectcatalog.Catalog {
	return projectcatalog.Catalog{
		Account: projectcatalog.Account{Login: "owner"},
		Catalog: projectcatalog.CatalogEvidence{
			CacheState: "fresh",
			CheckedAt:  "2026-07-28T00:00:00.000Z",
			Status:     "connected",
		},
		Projects: []projectcatalog.Project{
			{
				DisplayName:     "design-space",
				ID:              "github:1",
				LocalCandidates: []projectcatalog.LocalCandidate{},
				Repository:      "DotNaos/design-space",
			},
			{
				DisplayName: "project-space",
				ID:          "github:2",
				LocalCandidates: []projectcatalog.LocalCandidate{{
					Path:      local,
					ProjectID: "project-space",
				}},
				Repository: "DotNaos/project-space",
			},
		},
		SchemaVersion: 1,
	}
}

func executeProjectsFeatureCommand(t *testing.T, command *cobra.Command, args ...string) string {
	t.Helper()
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs(args)
	if err := command.Execute(); err != nil {
		t.Fatalf("execute %q: %v\n%s", args, err, output.String())
	}
	return output.String()
}
