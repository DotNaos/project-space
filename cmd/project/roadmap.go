package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/DotNaos/project-space/internal/roadmap"
	"github.com/spf13/cobra"
)

type roadmapCommandOptions struct {
	format     string
	repository string
}

func newRoadmapCommand() *cobra.Command {
	return newRoadmapCommandWithDependencies(defaultRoadmapCommandDependencies())
}

func newRoadmapCommandWithDependencies(
	dependencies roadmapCommandDependencies,
) *cobra.Command {
	options := roadmapCommandOptions{}
	command := &cobra.Command{
		Use:   "roadmap",
		Short: "Read and update the issue dependency roadmap",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := validateRoadmapCommand(dependencies, options.format); err != nil {
				return err
			}
			repository, runtime, err := resolveRoadmapRuntime(
				command.Context(),
				dependencies,
				options.repository,
			)
			if err != nil {
				return err
			}
			graph, err := runtime.client.Get(command.Context(), repository)
			if err != nil {
				return err
			}
			return writeRoadmapGraph(command.OutOrStdout(), graph, options.format)
		},
	}
	command.PersistentFlags().StringVar(
		&options.repository,
		"repository",
		"",
		"GitHub repository as owner/name (defaults to the current origin)",
	)
	command.PersistentFlags().StringVar(
		&options.format,
		"format",
		"text",
		"output format: text or json",
	)
	must(command.RegisterFlagCompletionFunc(
		"format",
		fixedValuesCompletion("text", "json"),
	))
	dependenciesCommand := &cobra.Command{
		Use:   "dependency",
		Short: "Update roadmap prerequisite relationships",
	}
	dependenciesCommand.AddCommand(newRoadmapDependencyMutationCommand(
		"add",
		dependencies,
		&options,
	))
	dependenciesCommand.AddCommand(newRoadmapDependencyMutationCommand(
		"remove",
		dependencies,
		&options,
	))
	command.AddCommand(dependenciesCommand)
	return command
}

func newRoadmapDependencyMutationCommand(
	operation string,
	dependencies roadmapCommandDependencies,
	options *roadmapCommandOptions,
) *cobra.Command {
	var requires int
	var requiresRepository string
	verb := "Add"
	if operation == "remove" {
		verb = "Remove"
	}
	command := &cobra.Command{
		Use:   operation + " <issue>",
		Short: verb + " an issue prerequisite",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if err := validateRoadmapCommand(dependencies, options.format); err != nil {
				return err
			}
			blocked, err := positiveIssueNumber(args[0])
			if err != nil {
				return err
			}
			if requires < 1 {
				return errors.New("--requires must be a positive issue number")
			}
			repository, runtime, err := resolveRoadmapRuntime(
				command.Context(),
				dependencies,
				options.repository,
			)
			if err != nil {
				return err
			}
			blockerRepository := requiresRepository
			if blockerRepository == "" {
				blockerRepository = repository
			} else if !githubRepositoryNamePattern.MatchString(blockerRepository) {
				return errors.New("--requires-repository must use the exact owner/name form")
			}
			current, err := runtime.client.Get(command.Context(), repository)
			if err != nil {
				return err
			}
			request := roadmap.MutationRequest{
				BlockedIssueNumber:    blocked,
				BlockerIssueNumber:    requires,
				BlockerRepository:     blockerRepository,
				ExpectedGraphRevision: current.GraphRevision,
				Repository:            repository,
			}
			var updated roadmap.Graph
			if operation == "add" {
				updated, err = runtime.client.AddDependency(command.Context(), request)
			} else {
				updated, err = runtime.client.RemoveDependency(command.Context(), request)
			}
			if err != nil {
				return err
			}
			if options.format == "json" {
				return writeRoadmapGraph(command.OutOrStdout(), updated, options.format)
			}
			message, err := roadmapDependencyMutationMessage(
				operation,
				current,
				updated,
				request,
			)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(
				command.OutOrStdout(),
				"%s: #%d requires %s\n",
				message,
				request.BlockedIssueNumber,
				roadmapIssueLabel(
					request.BlockerRepository,
					request.BlockerIssueNumber,
					request.Repository,
				),
			)
			return err
		},
	}
	command.Flags().IntVar(
		&requires,
		"requires",
		0,
		"prerequisite issue number",
	)
	command.Flags().StringVar(
		&requiresRepository,
		"requires-repository",
		"",
		"prerequisite repository as owner/name (defaults to --repository)",
	)
	return command
}

func roadmapDependencyMutationMessage(
	operation string,
	before roadmap.Graph,
	after roadmap.Graph,
	request roadmap.MutationRequest,
) (string, error) {
	from := roadmap.NodeReference{
		Number:     request.BlockerIssueNumber,
		Repository: request.BlockerRepository,
	}
	to := roadmap.NodeReference{
		Number:     request.BlockedIssueNumber,
		Repository: request.Repository,
	}
	existedBefore := roadmapHasDependency(before, from, to)
	existsAfter := roadmapHasDependency(after, from, to)
	switch {
	case operation == "add" && !existedBefore && existsAfter:
		return "Added dependency", nil
	case operation == "add" && existedBefore && existsAfter:
		return "Dependency already exists", nil
	case operation == "remove" && existedBefore && !existsAfter:
		return "Removed dependency", nil
	case operation == "remove" && !existedBefore && !existsAfter:
		return "Dependency not present", nil
	default:
		return "", roadmap.ErrInvalidResponse
	}
}

func roadmapHasDependency(
	graph roadmap.Graph,
	from roadmap.NodeReference,
	to roadmap.NodeReference,
) bool {
	key := roadmapEdgeKey(from, to)
	for _, edge := range graph.Edges {
		if roadmapEdgeKey(edge.From, edge.To) == key {
			return true
		}
	}
	return false
}

func validateRoadmapCommand(
	dependencies roadmapCommandDependencies,
	format string,
) error {
	if dependencies.LoadRuntime == nil || dependencies.ResolveRepository == nil {
		return errors.New("roadmap command dependencies are incomplete")
	}
	if format != "text" && format != "json" {
		return errors.New("--format must be text or json")
	}
	return nil
}

func resolveRoadmapRuntime(
	ctx context.Context,
	dependencies roadmapCommandDependencies,
	explicitRepository string,
) (string, roadmapCommandRuntime, error) {
	repository := explicitRepository
	var err error
	if repository == "" {
		repository, err = dependencies.ResolveRepository(ctx)
		if err != nil {
			return "", roadmapCommandRuntime{}, err
		}
	} else if !githubRepositoryNamePattern.MatchString(repository) {
		return "", roadmapCommandRuntime{}, errors.New(
			"--repository must use the exact owner/name form",
		)
	}
	runtime, err := dependencies.LoadRuntime(ctx)
	if err != nil {
		return "", roadmapCommandRuntime{}, err
	}
	if runtime.client == nil {
		return "", roadmapCommandRuntime{}, errors.New("roadmap service is unavailable")
	}
	return repository, runtime, nil
}

func positiveIssueNumber(value string) (int, error) {
	number, err := strconv.Atoi(value)
	if err != nil || number < 1 {
		return 0, errors.New("issue must be a positive issue number")
	}
	return number, nil
}

func writeRoadmapGraph(output io.Writer, graph roadmap.Graph, format string) error {
	if format == "json" {
		encoder := json.NewEncoder(output)
		encoder.SetIndent("", "  ")
		return encoder.Encode(graph)
	}
	if len(graph.Paths) == 0 {
		_, err := fmt.Fprintln(output, "No roadmap issues.")
		return err
	}
	nodes := make(map[string]roadmap.Node, len(graph.Nodes))
	for _, node := range graph.Nodes {
		nodes[roadmapReferenceKey(node.NodeReference)] = node
	}
	edges := make(map[string]roadmap.Edge, len(graph.Edges))
	for _, edge := range graph.Edges {
		edges[roadmapEdgeKey(edge.From, edge.To)] = edge
	}
	for _, path := range graph.Paths {
		var line strings.Builder
		for index, reference := range path {
			node, found := nodes[roadmapReferenceKey(reference)]
			if !found {
				return roadmap.ErrInvalidResponse
			}
			if index > 0 {
				edge, edgeFound := edges[roadmapEdgeKey(path[index-1], reference)]
				if !edgeFound {
					return roadmap.ErrInvalidResponse
				}
				if edge.Satisfied {
					line.WriteString(" -> ")
				} else {
					line.WriteString(" -[BLOCKS]-> ")
				}
			}
			line.WriteString(roadmapIssueLabel(
				node.Repository,
				node.Number,
				graph.Repository,
			))
			line.WriteString("[")
			line.WriteString(string(node.State))
			line.WriteString("]")
		}
		if _, err := fmt.Fprintln(output, line.String()); err != nil {
			return err
		}
	}
	return nil
}

func roadmapIssueLabel(repository string, number int, localRepository string) string {
	if strings.EqualFold(repository, localRepository) {
		return "#" + strconv.Itoa(number)
	}
	return repository + "#" + strconv.Itoa(number)
}

func roadmapReferenceKey(reference roadmap.NodeReference) string {
	return strings.ToLower(reference.Repository) + "#" + strconv.Itoa(reference.Number)
}

func roadmapEdgeKey(from roadmap.NodeReference, to roadmap.NodeReference) string {
	return roadmapReferenceKey(from) + ">" + roadmapReferenceKey(to)
}
