package main

import (
	"context"
	"errors"

	"github.com/spf13/cobra"
)

type roadmapCommandOptions struct {
	format     string
	repository string
	verbose    bool
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
			return writeRoadmapGraph(
				command.OutOrStdout(),
				graph,
				options.format,
				options.verbose,
				roadmapOutputWidth(dependencies, command.OutOrStdout()),
			)
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
	command.Flags().BoolVar(
		&options.verbose,
		"verbose",
		false,
		"include issue titles and normalized descriptions",
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
