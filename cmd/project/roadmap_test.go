package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/roadmap"
	"github.com/spf13/cobra"
)

type fakeRoadmapAPI struct {
	addError        error
	addRequests     []roadmap.MutationRequest
	getError        error
	getRepositories []string
	graph           roadmap.Graph
	mutationGraph   *roadmap.Graph
	removeError     error
	removeRequests  []roadmap.MutationRequest
}

func (api *fakeRoadmapAPI) Get(
	_ context.Context,
	repository string,
) (roadmap.Graph, error) {
	api.getRepositories = append(api.getRepositories, repository)
	if api.getError != nil {
		return roadmap.Graph{}, api.getError
	}
	return api.graph, nil
}

func (api *fakeRoadmapAPI) AddDependency(
	_ context.Context,
	request roadmap.MutationRequest,
) (roadmap.Graph, error) {
	api.addRequests = append(api.addRequests, request)
	if api.addError != nil {
		return roadmap.Graph{}, api.addError
	}
	if api.mutationGraph != nil {
		return *api.mutationGraph, nil
	}
	return api.graph, nil
}

func (api *fakeRoadmapAPI) RemoveDependency(
	_ context.Context,
	request roadmap.MutationRequest,
) (roadmap.Graph, error) {
	api.removeRequests = append(api.removeRequests, request)
	if api.removeError != nil {
		return roadmap.Graph{}, api.removeError
	}
	if api.mutationGraph != nil {
		return *api.mutationGraph, nil
	}
	return api.graph, nil
}

func roadmapCommandGraph() roadmap.Graph {
	repository := "DotNaos/project-space"
	reference := func(number int) roadmap.NodeReference {
		return roadmap.NodeReference{Number: number, Repository: repository}
	}
	return roadmap.Graph{
		DependencyFreshness: "current",
		Edges: []roadmap.Edge{
			{From: reference(298), Satisfied: true, To: reference(412)},
			{From: reference(298), Satisfied: true, To: reference(413)},
			{From: reference(412), Satisfied: false, To: reference(420)},
			{From: reference(413), Satisfied: false, To: reference(420)},
		},
		GraphRevision: "12345678",
		Issues: []roadmap.Issue{
			{
				NodeReference: reference(298),
				Description:   "# Root description\n\nwith **Markdown**.",
				Title:         "Root",
			},
			{NodeReference: reference(412), Description: "Left details", Title: "Left"},
			{NodeReference: reference(413), Description: "", Title: "Right"},
			{NodeReference: reference(420), Description: "Join details", Title: "Join"},
			{NodeReference: reference(500), Description: "Standalone details", Title: "Standalone"},
			{NodeReference: reference(777), Description: "Unplanned details", Title: "Unplanned"},
		},
		Nodes: []roadmap.Node{
			{
				NodeReference: reference(298),
				Description:   "# Root description\n\nwith **Markdown**.",
				State:         roadmap.NodeDone,
				Title:         "Root",
			},
			{
				NodeReference: reference(412),
				Description:   "Left details",
				State:         roadmap.NodeReady,
				Title:         "Left",
			},
			{NodeReference: reference(413), State: roadmap.NodeActive, Title: "Right"},
			{
				NodeReference: reference(420),
				Description:   "Join details",
				State:         roadmap.NodeWait,
				Title:         "Join",
			},
			{
				NodeReference: reference(500),
				Description:   "Standalone details",
				State:         roadmap.NodeReady,
				Title:         "Standalone",
			},
		},
		Paths: [][]roadmap.NodeReference{
			{reference(298), reference(412), reference(420)},
			{reference(298), reference(413), reference(420)},
			{reference(500)},
		},
		Repository: repository,
	}
}

func executeRoadmapCommand(
	t *testing.T,
	api *fakeRoadmapAPI,
	resolve func(context.Context) (string, error),
	args ...string,
) (string, error) {
	t.Helper()
	command := newRoadmapCommandWithDependencies(roadmapCommandDependencies{
		Interactive: func(io.Reader, io.Writer) bool { return false },
		LoadRuntime: func(context.Context) (roadmapCommandRuntime, error) {
			return roadmapCommandRuntime{client: api}, nil
		},
		ResolveRepository: resolve,
		TerminalWidth:     func(io.Writer) int { return 100 },
	})
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs(args)
	err := command.Execute()
	return output.String(), err
}

func TestRoadmapCommandRendersEveryPathDeterministically(t *testing.T) {
	api := &fakeRoadmapAPI{graph: roadmapCommandGraph()}
	output, err := executeRoadmapCommand(
		t,
		api,
		func(context.Context) (string, error) {
			return "DotNaos/project-space", nil
		},
	)
	if err != nil {
		t.Fatalf("execute roadmap: %v", err)
	}
	want := strings.Join([]string{
		"#298[DONE] -> #412[READY] -[BLOCKS]-> #420[WAIT]",
		"#298[DONE] -> #413[ACTIVE] -[BLOCKS]-> #420[WAIT]",
		"#500[READY]",
		"",
	}, "\n")
	if output != want {
		t.Fatalf("output = %q, want %q", output, want)
	}
}

func TestRoadmapCommandVerboseNormalizesDescriptionsAndPreservesPaths(t *testing.T) {
	api := &fakeRoadmapAPI{graph: roadmapCommandGraph()}
	output, err := executeRoadmapCommand(
		t,
		api,
		func(context.Context) (string, error) {
			return "DotNaos/project-space", nil
		},
		"--verbose",
	)
	if err != nil {
		t.Fatalf("execute verbose roadmap: %v", err)
	}
	want := strings.Join([]string{
		"#298[DONE] Root — Root description with Markdown.",
		"  -> #412[READY] Left — Left details",
		"  -[BLOCKS]-> #420[WAIT] Join — Join details",
		"",
		"#298[DONE] Root — Root description with Markdown.",
		"  -> #413[ACTIVE] Right — No description.",
		"  -[BLOCKS]-> #420[WAIT] Join — Join details",
		"",
		"#500[READY] Standalone — Standalone details",
		"",
	}, "\n")
	if output != want {
		t.Fatalf("verbose output = %q, want %q", output, want)
	}
}

func TestRoadmapVerboseKeepsTitleAndDescriptionInsideNarrowTerminal(t *testing.T) {
	output := &bytes.Buffer{}
	if err := writeRoadmapGraph(output, roadmapCommandGraph(), "text", true, 40); err != nil {
		t.Fatalf("write narrow verbose roadmap: %v", err)
	}
	for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		if line == "" {
			continue
		}
		if len([]rune(line)) > 40 {
			t.Fatalf("line exceeds terminal width: %q", line)
		}
		if !strings.Contains(line, " — ") {
			t.Fatalf("line does not preserve title and description: %q", line)
		}
	}
}

func TestRoadmapCommandUsesExplicitRepositoryAndWritesJSON(t *testing.T) {
	api := &fakeRoadmapAPI{graph: roadmapCommandGraph()}
	resolved := false
	output, err := executeRoadmapCommand(
		t,
		api,
		func(context.Context) (string, error) {
			resolved = true
			return "", errors.New("should not resolve")
		},
		"--repository",
		"DotNaos/project-space",
		"--format",
		"json",
	)
	if err != nil {
		t.Fatalf("execute roadmap JSON: %v", err)
	}
	if resolved {
		t.Fatal("current repository resolver was called for explicit repository")
	}
	var graph roadmap.Graph
	if err := json.Unmarshal([]byte(output), &graph); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
	if !reflect.DeepEqual(graph, api.graph) {
		t.Fatalf("graph = %#v, want %#v", graph, api.graph)
	}
}

func TestRoadmapDependencyMutationsUseFreshRevisionAndRepeatRelationship(t *testing.T) {
	for _, operation := range []string{"add", "remove"} {
		current := roadmapCommandGraph()
		updated := current
		if operation == "add" {
			current.Edges = current.Edges[1:]
		} else {
			updated.Edges = updated.Edges[1:]
		}
		api := &fakeRoadmapAPI{graph: current, mutationGraph: &updated}
		output, err := executeRoadmapCommand(
			t,
			api,
			func(context.Context) (string, error) {
				return "DotNaos/project-space", nil
			},
			"dependency",
			operation,
			"412",
			"--requires",
			"298",
		)
		if err != nil {
			t.Fatalf("%s dependency: %v", operation, err)
		}
		wantPrefix := "Added"
		requests := api.addRequests
		if operation == "remove" {
			wantPrefix = "Removed"
			requests = api.removeRequests
		}
		if output != wantPrefix+" dependency: #412 requires #298\n" {
			t.Fatalf("%s output = %q", operation, output)
		}
		wantRequest := roadmap.MutationRequest{
			BlockedIssueNumber:    412,
			BlockerIssueNumber:    298,
			BlockerRepository:     "DotNaos/project-space",
			ExpectedGraphRevision: "12345678",
			Repository:            "DotNaos/project-space",
		}
		if !reflect.DeepEqual(requests, []roadmap.MutationRequest{wantRequest}) {
			t.Fatalf("%s requests = %#v", operation, requests)
		}
		if !reflect.DeepEqual(api.getRepositories, []string{"DotNaos/project-space"}) {
			t.Fatalf("%s read repositories = %#v", operation, api.getRepositories)
		}
	}
}

func TestRoadmapDependencySupportsExplicitCrossRepositoryBlocker(t *testing.T) {
	current := roadmapCommandGraph()
	updated := current
	updated.Edges = append(updated.Edges, roadmap.Edge{
		From: roadmap.NodeReference{Number: 17, Repository: "DotNaos/platform"},
		To:   roadmap.NodeReference{Number: 412, Repository: current.Repository},
	})
	api := &fakeRoadmapAPI{graph: current, mutationGraph: &updated}
	output, err := executeRoadmapCommand(
		t,
		api,
		func(context.Context) (string, error) {
			return "DotNaos/project-space", nil
		},
		"dependency",
		"add",
		"412",
		"--requires",
		"17",
		"--requires-repository",
		"DotNaos/platform",
	)
	if err != nil {
		t.Fatalf("add cross-repository dependency: %v", err)
	}
	if output != "Added dependency: #412 requires DotNaos/platform#17\n" {
		t.Fatalf("output = %q", output)
	}
	if api.addRequests[0].BlockerRepository != "DotNaos/platform" {
		t.Fatalf("request = %#v", api.addRequests[0])
	}
}

func TestRoadmapDependencyMutationReportsNoOpAccurately(t *testing.T) {
	for _, test := range []struct {
		operation string
		requires  string
		want      string
	}{
		{operation: "add", requires: "298", want: "Dependency already exists"},
		{operation: "remove", requires: "500", want: "Dependency not present"},
	} {
		api := &fakeRoadmapAPI{graph: roadmapCommandGraph()}
		output, err := executeRoadmapCommand(
			t,
			api,
			func(context.Context) (string, error) {
				return "DotNaos/project-space", nil
			},
			"dependency",
			test.operation,
			"412",
			"--requires",
			test.requires,
		)
		if err != nil {
			t.Fatalf("%s dependency: %v", test.operation, err)
		}
		want := test.want + ": #412 requires #" + test.requires + "\n"
		if output != want {
			t.Fatalf("%s output = %q, want %q", test.operation, output, want)
		}
	}
}

func TestRoadmapCommandValidatesBeforeLoadingRuntime(t *testing.T) {
	loaded := false
	command := newRoadmapCommandWithDependencies(roadmapCommandDependencies{
		LoadRuntime: func(context.Context) (roadmapCommandRuntime, error) {
			loaded = true
			return roadmapCommandRuntime{}, nil
		},
		ResolveRepository: func(context.Context) (string, error) {
			return "DotNaos/project-space", nil
		},
	})
	command.SetArgs([]string{"--format", "yaml"})
	if err := command.Execute(); err == nil || !strings.Contains(err.Error(), "--format") {
		t.Fatalf("error = %v", err)
	}
	if loaded {
		t.Fatal("runtime loaded before format validation")
	}
}

func TestRoadmapCompletionUsesCatalogDescriptionsAndNeverFallsBackToFiles(t *testing.T) {
	api := &fakeRoadmapAPI{graph: roadmapCommandGraph()}
	resolved := 0
	command := newRoadmapCommandWithDependencies(roadmapCommandDependencies{
		LoadRuntime: func(context.Context) (roadmapCommandRuntime, error) {
			return roadmapCommandRuntime{client: api}, nil
		},
		ResolveRepository: func(context.Context) (string, error) {
			resolved++
			return "DotNaos/project-space", nil
		},
	})
	add, _, err := command.Find([]string{"dependency", "add"})
	if err != nil {
		t.Fatalf("find add command: %v", err)
	}
	values, directive := add.ValidArgsFunction(add, nil, "7")
	if directive&cobra.ShellCompDirectiveNoFileComp == 0 {
		t.Fatalf("positional directive = %v", directive)
	}
	if !reflect.DeepEqual(values, []string{"777\tUnplanned — Unplanned details"}) {
		t.Fatalf("positional completions = %#v", values)
	}
	requiresCompletion, ok := add.GetFlagCompletionFunc("requires")
	if !ok {
		t.Fatal("requires completion is not registered")
	}
	values, directive = requiresCompletion(add, []string{"412"}, "5")
	if directive&cobra.ShellCompDirectiveNoFileComp == 0 {
		t.Fatalf("requires directive = %v", directive)
	}
	if !reflect.DeepEqual(values, []string{"500\tStandalone — Standalone details"}) {
		t.Fatalf("requires completions = %#v", values)
	}
	if resolved != 2 {
		t.Fatalf("repository resolved %d times, want 2", resolved)
	}
}

func TestRoadmapRemoveCompletionOnlyOffersExistingRelationships(t *testing.T) {
	api := &fakeRoadmapAPI{graph: roadmapCommandGraph()}
	command := newRoadmapCommandWithDependencies(roadmapCommandDependencies{
		LoadRuntime: func(context.Context) (roadmapCommandRuntime, error) {
			return roadmapCommandRuntime{client: api}, nil
		},
		ResolveRepository: func(context.Context) (string, error) {
			return "DotNaos/project-space", nil
		},
	})
	remove, _, err := command.Find([]string{"dependency", "remove"})
	if err != nil {
		t.Fatalf("find remove command: %v", err)
	}
	values, directive := remove.ValidArgsFunction(remove, nil, "")
	if directive&cobra.ShellCompDirectiveNoFileComp == 0 {
		t.Fatalf("positional directive = %v", directive)
	}
	wantBlocked := []string{
		"412\tLeft — Left details",
		"413\tRight — No description.",
		"420\tJoin — Join details",
	}
	if !reflect.DeepEqual(values, wantBlocked) {
		t.Fatalf("remove issue completions = %#v, want %#v", values, wantBlocked)
	}
	requiresCompletion, ok := remove.GetFlagCompletionFunc("requires")
	if !ok {
		t.Fatal("requires completion is not registered")
	}
	values, directive = requiresCompletion(remove, []string{"420"}, "")
	if directive&cobra.ShellCompDirectiveNoFileComp == 0 {
		t.Fatalf("requires directive = %v", directive)
	}
	wantRequires := []string{
		"412\tLeft — Left details",
		"413\tRight — No description.",
	}
	if !reflect.DeepEqual(values, wantRequires) {
		t.Fatalf("remove prerequisite completions = %#v, want %#v", values, wantRequires)
	}
}

func TestRoadmapCompletionFailsQuietlyWithoutFilesystemFallback(t *testing.T) {
	api := &fakeRoadmapAPI{getError: errors.New("server unavailable")}
	command := newRoadmapCommandWithDependencies(roadmapCommandDependencies{
		LoadRuntime: func(context.Context) (roadmapCommandRuntime, error) {
			return roadmapCommandRuntime{client: api}, nil
		},
		ResolveRepository: func(context.Context) (string, error) {
			return "DotNaos/project-space", nil
		},
	})
	add, _, err := command.Find([]string{"dependency", "add"})
	if err != nil {
		t.Fatalf("find add command: %v", err)
	}
	values, directive := add.ValidArgsFunction(add, nil, "")
	if len(values) != 0 || directive&cobra.ShellCompDirectiveNoFileComp == 0 {
		t.Fatalf("values = %#v, directive = %v", values, directive)
	}
}

func TestRoadmapInteractiveAddSelectsDependentThenPrerequisite(t *testing.T) {
	current := roadmapCommandGraph()
	updated := current
	updated.Edges = append(updated.Edges, roadmap.Edge{
		From: roadmap.NodeReference{Number: 500, Repository: current.Repository},
		To:   roadmap.NodeReference{Number: 777, Repository: current.Repository},
	})
	api := &fakeRoadmapAPI{graph: current, mutationGraph: &updated}
	prompts := []string{}
	command := newRoadmapCommandWithDependencies(roadmapCommandDependencies{
		Interactive: func(io.Reader, io.Writer) bool { return true },
		LoadRuntime: func(context.Context) (roadmapCommandRuntime, error) {
			return roadmapCommandRuntime{client: api}, nil
		},
		PickIssue: func(
			_ context.Context,
			_ io.Reader,
			_ io.Writer,
			prompt string,
			issues []roadmap.Issue,
			_ string,
		) (roadmap.Issue, bool, error) {
			prompts = append(prompts, prompt)
			number := 777
			if len(prompts) == 2 {
				number = 500
			}
			for _, issue := range issues {
				if issue.Number == number {
					return issue, true, nil
				}
			}
			t.Fatalf("issue #%d missing from candidates %#v", number, issues)
			return roadmap.Issue{}, false, nil
		},
		ResolveRepository: func(context.Context) (string, error) {
			return current.Repository, nil
		},
	})
	output := &bytes.Buffer{}
	command.SetIn(strings.NewReader(""))
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs([]string{"dependency", "add"})
	if err := command.Execute(); err != nil {
		t.Fatalf("interactive add: %v", err)
	}
	if !reflect.DeepEqual(prompts, []string{
		"Choose the dependent issue",
		"Choose the prerequisite issue",
	}) {
		t.Fatalf("prompts = %#v", prompts)
	}
	if len(api.addRequests) != 1 ||
		api.addRequests[0].BlockedIssueNumber != 777 ||
		api.addRequests[0].BlockerIssueNumber != 500 {
		t.Fatalf("add requests = %#v", api.addRequests)
	}
}

func TestRoadmapInteractiveRemoveConstrainsPrerequisitesAndCancels(t *testing.T) {
	api := &fakeRoadmapAPI{graph: roadmapCommandGraph()}
	picks := 0
	command := newRoadmapCommandWithDependencies(roadmapCommandDependencies{
		Interactive: func(io.Reader, io.Writer) bool { return true },
		LoadRuntime: func(context.Context) (roadmapCommandRuntime, error) {
			return roadmapCommandRuntime{client: api}, nil
		},
		PickIssue: func(
			_ context.Context,
			_ io.Reader,
			_ io.Writer,
			_ string,
			issues []roadmap.Issue,
			_ string,
		) (roadmap.Issue, bool, error) {
			picks++
			if picks == 1 {
				for _, issue := range issues {
					if issue.Number == 420 {
						return issue, true, nil
					}
				}
			}
			numbers := make([]int, len(issues))
			for index, issue := range issues {
				numbers[index] = issue.Number
			}
			if !reflect.DeepEqual(numbers, []int{412, 413}) {
				t.Fatalf("remove prerequisite candidates = %#v", numbers)
			}
			return roadmap.Issue{}, false, nil
		},
		ResolveRepository: func(context.Context) (string, error) {
			return "DotNaos/project-space", nil
		},
	})
	output := &bytes.Buffer{}
	command.SetIn(strings.NewReader(""))
	command.SetOut(output)
	command.SetErr(output)
	command.SetArgs([]string{"dependency", "remove"})
	if err := command.Execute(); err != nil {
		t.Fatalf("interactive remove cancellation: %v", err)
	}
	if len(api.removeRequests) != 0 {
		t.Fatalf("remove requests after cancellation = %#v", api.removeRequests)
	}
	if !strings.Contains(output.String(), "Selection cancelled; roadmap unchanged.") {
		t.Fatalf("cancellation output = %q", output.String())
	}
}

func TestRoadmapMissingValuesFailBeforeServerReadOutsideTTY(t *testing.T) {
	api := &fakeRoadmapAPI{graph: roadmapCommandGraph()}
	output, err := executeRoadmapCommand(
		t,
		api,
		func(context.Context) (string, error) {
			return "DotNaos/project-space", nil
		},
		"dependency",
		"add",
	)
	if err == nil || !strings.Contains(err.Error(), "not an interactive terminal") {
		t.Fatalf("error = %v, output = %q", err, output)
	}
	if len(api.getRepositories) != 0 {
		t.Fatalf("server reads = %#v", api.getRepositories)
	}
}
