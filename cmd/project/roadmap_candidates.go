package main

import (
	"sort"
	"strconv"
	"strings"

	"github.com/DotNaos/project-space/internal/roadmap"
	"github.com/spf13/cobra"
)

func roadmapBlockedIssueCandidates(
	graph roadmap.Graph,
	repository string,
	operation string,
) []roadmap.Issue {
	allowed := map[string]bool{}
	if operation == "remove" {
		for _, edge := range graph.Edges {
			if roadmapSameRepository(edge.To.Repository, repository) {
				allowed[roadmapReferenceKey(edge.To)] = true
			}
		}
	}
	return filterRoadmapIssues(graph.Issues, func(issue roadmap.Issue) bool {
		return roadmapSameRepository(issue.Repository, repository) &&
			(operation != "remove" || allowed[roadmapReferenceKey(issue.NodeReference)])
	})
}

func roadmapBlockerIssueCandidates(
	graph roadmap.Graph,
	repository string,
	operation string,
	blocked int,
	explicitRepository string,
) []roadmap.Issue {
	blockedReference := roadmap.NodeReference{Number: blocked, Repository: repository}
	existing := map[string]bool{}
	for _, edge := range graph.Edges {
		if roadmapReferenceKey(edge.To) == roadmapReferenceKey(blockedReference) {
			existing[roadmapReferenceKey(edge.From)] = true
		}
	}
	return filterRoadmapIssues(graph.Issues, func(issue roadmap.Issue) bool {
		if explicitRepository != "" &&
			!roadmapSameRepository(issue.Repository, explicitRepository) {
			return false
		}
		key := roadmapReferenceKey(issue.NodeReference)
		if operation == "remove" {
			return existing[key]
		}
		return key != roadmapReferenceKey(blockedReference) && !existing[key]
	})
}

func filterRoadmapIssues(
	issues []roadmap.Issue,
	keep func(roadmap.Issue) bool,
) []roadmap.Issue {
	result := make([]roadmap.Issue, 0, len(issues))
	seen := map[string]bool{}
	for _, issue := range issues {
		key := roadmapReferenceKey(issue.NodeReference)
		if !seen[key] && keep(issue) {
			result = append(result, issue)
			seen[key] = true
		}
	}
	sort.Slice(result, func(left int, right int) bool {
		leftRepository := strings.ToLower(result[left].Repository)
		rightRepository := strings.ToLower(result[right].Repository)
		if leftRepository != rightRepository {
			return leftRepository < rightRepository
		}
		if result[left].Repository != result[right].Repository {
			return result[left].Repository < result[right].Repository
		}
		return result[left].Number < result[right].Number
	})
	return result
}

func roadmapPositionalIssueCompletion(
	operation string,
	dependencies roadmapCommandDependencies,
	options *roadmapCommandOptions,
) cobra.CompletionFunc {
	return func(
		command *cobra.Command,
		args []string,
		toComplete string,
	) ([]string, cobra.ShellCompDirective) {
		if len(args) > 0 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		graph, repository, ok := loadRoadmapCompletionGraph(
			command,
			dependencies,
			options.repository,
		)
		if !ok {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		return roadmapCompletionValues(
			roadmapBlockedIssueCandidates(graph, repository, operation),
			toComplete,
		), cobra.ShellCompDirectiveNoFileComp
	}
}

func roadmapRequiresCompletion(
	operation string,
	dependencies roadmapCommandDependencies,
	options *roadmapCommandOptions,
) cobra.CompletionFunc {
	return func(
		command *cobra.Command,
		args []string,
		toComplete string,
	) ([]string, cobra.ShellCompDirective) {
		if len(args) != 1 {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		blocked, err := positiveIssueNumber(args[0])
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		graph, repository, ok := loadRoadmapCompletionGraph(
			command,
			dependencies,
			options.repository,
		)
		if !ok {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		requiresRepository, _ := command.Flags().GetString("requires-repository")
		if requiresRepository == "" {
			requiresRepository = repository
		}
		return roadmapCompletionValues(
			roadmapBlockerIssueCandidates(
				graph,
				repository,
				operation,
				blocked,
				requiresRepository,
			),
			toComplete,
		), cobra.ShellCompDirectiveNoFileComp
	}
}

func loadRoadmapCompletionGraph(
	command *cobra.Command,
	dependencies roadmapCommandDependencies,
	explicitRepository string,
) (roadmap.Graph, string, bool) {
	repository, runtime, err := resolveRoadmapRuntime(
		command.Context(),
		dependencies,
		explicitRepository,
	)
	if err != nil {
		return roadmap.Graph{}, "", false
	}
	graph, err := runtime.client.Get(command.Context(), repository)
	if err != nil {
		return roadmap.Graph{}, "", false
	}
	return graph, repository, true
}

func roadmapCompletionValues(
	issues []roadmap.Issue,
	toComplete string,
) []string {
	result := make([]string, 0, len(issues))
	for _, issue := range issues {
		value := strconv.Itoa(issue.Number)
		if !strings.HasPrefix(value, toComplete) {
			continue
		}
		description := normalizedRoadmapText(issue.Title)
		detail := normalizedRoadmapDescription(issue.Description)
		if description != "" {
			description += " — " + detail
		} else {
			description = detail
		}
		result = append(result, value+"\t"+truncateRoadmapText(description, 96))
	}
	return result
}
