package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/DotNaos/project-space/internal/roadmap"
	"github.com/spf13/cobra"
)

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
		Use:   operation + " [issue]",
		Short: verb + " an issue prerequisite",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if err := validateRoadmapCommand(dependencies, options.format); err != nil {
				return err
			}
			requiresProvided := command.Flags().Changed("requires")
			if requiresProvided && requires < 1 {
				return errors.New("--requires must be a positive issue number")
			}
			missingValues := len(args) == 0 || !requiresProvided
			if missingValues && !roadmapInteractive(
				dependencies,
				command.InOrStdin(),
				command.ErrOrStderr(),
			) {
				return errors.New(
					"issue and --requires are required when input is not an interactive terminal; " +
						"use: project roadmap dependency " + operation + " <issue> --requires <issue>",
				)
			}
			repository, runtime, err := resolveRoadmapRuntime(
				command.Context(),
				dependencies,
				options.repository,
			)
			if err != nil {
				return err
			}
			current, err := runtime.client.Get(command.Context(), repository)
			if err != nil {
				return err
			}
			blocked, selected, err := resolveBlockedIssue(
				command,
				dependencies,
				current,
				repository,
				operation,
				args,
			)
			if err != nil || !selected {
				return finishRoadmapSelection(command, selected, err)
			}
			blockerRepository, blocker, selected, err := resolveBlockerIssue(
				command,
				dependencies,
				current,
				repository,
				operation,
				blocked,
				requires,
				requiresProvided,
				requiresRepository,
			)
			if err != nil || !selected {
				return finishRoadmapSelection(command, selected, err)
			}
			request := roadmap.MutationRequest{
				BlockedIssueNumber:    blocked,
				BlockerIssueNumber:    blocker,
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
				return writeRoadmapGraph(
					command.OutOrStdout(),
					updated,
					options.format,
					false,
					roadmapOutputWidth(dependencies, command.OutOrStdout()),
				)
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
	command.ValidArgsFunction = roadmapPositionalIssueCompletion(
		operation,
		dependencies,
		options,
	)
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
	must(command.RegisterFlagCompletionFunc(
		"requires",
		roadmapRequiresCompletion(operation, dependencies, options),
	))
	return command
}

func resolveBlockedIssue(
	command *cobra.Command,
	dependencies roadmapCommandDependencies,
	graph roadmap.Graph,
	repository string,
	operation string,
	args []string,
) (int, bool, error) {
	if len(args) > 0 {
		number, err := positiveIssueNumber(args[0])
		return number, err == nil, err
	}
	candidates := roadmapBlockedIssueCandidates(graph, repository, operation)
	selected, ok, err := pickRoadmapIssue(
		command,
		dependencies,
		"Choose the dependent issue",
		candidates,
		graph.Repository,
	)
	return selected.Number, ok, err
}

func resolveBlockerIssue(
	command *cobra.Command,
	dependencies roadmapCommandDependencies,
	graph roadmap.Graph,
	repository string,
	operation string,
	blocked int,
	requires int,
	requiresProvided bool,
	requiresRepository string,
) (string, int, bool, error) {
	if requiresRepository != "" &&
		!githubRepositoryNamePattern.MatchString(requiresRepository) {
		return "", 0, false, errors.New(
			"--requires-repository must use the exact owner/name form",
		)
	}
	if requiresProvided {
		if requiresRepository == "" {
			requiresRepository = repository
		}
		return requiresRepository, requires, true, nil
	}
	candidates := roadmapBlockerIssueCandidates(
		graph,
		repository,
		operation,
		blocked,
		requiresRepository,
	)
	selected, ok, err := pickRoadmapIssue(
		command,
		dependencies,
		"Choose the prerequisite issue",
		candidates,
		graph.Repository,
	)
	return selected.Repository, selected.Number, ok, err
}

func pickRoadmapIssue(
	command *cobra.Command,
	dependencies roadmapCommandDependencies,
	prompt string,
	candidates []roadmap.Issue,
	localRepository string,
) (roadmap.Issue, bool, error) {
	if len(candidates) == 0 {
		return roadmap.Issue{}, false, errors.New("no matching roadmap issues are available")
	}
	if dependencies.PickIssue == nil {
		return roadmap.Issue{}, false, errors.New("roadmap issue picker is unavailable")
	}
	return dependencies.PickIssue(
		command.Context(),
		command.InOrStdin(),
		command.ErrOrStderr(),
		prompt,
		candidates,
		localRepository,
	)
}

func finishRoadmapSelection(
	command *cobra.Command,
	selected bool,
	err error,
) error {
	if err != nil {
		return err
	}
	if selected {
		return nil
	}
	_, writeErr := fmt.Fprintln(
		command.ErrOrStderr(),
		"Selection cancelled; roadmap unchanged.",
	)
	return writeErr
}

func positiveIssueNumber(value string) (int, error) {
	number, err := strconv.Atoi(value)
	if err != nil || number < 1 {
		return 0, errors.New("issue must be a positive issue number")
	}
	return number, nil
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

func roadmapSameRepository(left string, right string) bool {
	return strings.EqualFold(left, right)
}
