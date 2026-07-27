package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/roadmap"
)

type fakeRoadmapAPI struct {
	addRequests     []roadmap.MutationRequest
	getRepositories []string
	graph           roadmap.Graph
	removeRequests  []roadmap.MutationRequest
}

func (api *fakeRoadmapAPI) Get(
	_ context.Context,
	repository string,
) (roadmap.Graph, error) {
	api.getRepositories = append(api.getRepositories, repository)
	return api.graph, nil
}

func (api *fakeRoadmapAPI) AddDependency(
	_ context.Context,
	request roadmap.MutationRequest,
) (roadmap.Graph, error) {
	api.addRequests = append(api.addRequests, request)
	return api.graph, nil
}

func (api *fakeRoadmapAPI) RemoveDependency(
	_ context.Context,
	request roadmap.MutationRequest,
) (roadmap.Graph, error) {
	api.removeRequests = append(api.removeRequests, request)
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
		Nodes: []roadmap.Node{
			{NodeReference: reference(298), State: roadmap.NodeDone, Title: "Root"},
			{NodeReference: reference(412), State: roadmap.NodeReady, Title: "Left"},
			{NodeReference: reference(413), State: roadmap.NodeActive, Title: "Right"},
			{NodeReference: reference(420), State: roadmap.NodeWait, Title: "Join"},
			{NodeReference: reference(500), State: roadmap.NodeReady, Title: "Standalone"},
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
		LoadRuntime: func(context.Context) (roadmapCommandRuntime, error) {
			return roadmapCommandRuntime{client: api}, nil
		},
		ResolveRepository: resolve,
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
		api := &fakeRoadmapAPI{graph: roadmapCommandGraph()}
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
	api := &fakeRoadmapAPI{graph: roadmapCommandGraph()}
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
