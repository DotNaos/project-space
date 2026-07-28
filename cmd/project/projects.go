package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/DotNaos/project-space/internal/projectcatalog"
	"github.com/DotNaos/project-space/internal/terminallauncher"
	"github.com/spf13/cobra"
)

type projectListSource struct {
	CacheState string `json:"cacheState,omitempty"`
	CheckedAt  string `json:"checkedAt"`
	Status     string `json:"status"`
}

type projectListItem struct {
	ID             string   `json:"id"`
	LocalAvailable bool     `json:"localAvailable"`
	LocalPath      *string  `json:"localPath"`
	LocalPaths     []string `json:"localPaths"`
	Name           string   `json:"name"`
	ReportedPaths  []string `json:"reportedPaths"`
	Repository     string   `json:"repository"`
}

type projectListResult struct {
	Projects      []projectListItem `json:"projects"`
	SchemaVersion int               `json:"schemaVersion"`
	Source        projectListSource `json:"source"`
}

type projectPathResult struct {
	Path          string                   `json:"path"`
	Project       projectPathResultProject `json:"project"`
	SchemaVersion int                      `json:"schemaVersion"`
}

type projectOpenResult struct {
	Launcher      string                     `json:"launcher"`
	Path          string                     `json:"path"`
	Project       projectPathResultProject   `json:"project"`
	SchemaVersion int                        `json:"schemaVersion"`
	Selection     terminallauncher.Selection `json:"selection"`
}

type projectPathResultProject struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Repository string `json:"repository"`
}

func newProjectListCommand() *cobra.Command {
	return newProjectListCommandWithDependencies(defaultProjectCommandsDependencies())
}

func newProjectListCommandWithDependencies(
	dependencies projectCommandsDependencies,
) *cobra.Command {
	format := "text"
	command := &cobra.Command{
		Use:   "list",
		Short: "List account projects and local availability",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if format != "text" && format != "json" {
				return errors.New("--format must be text or json")
			}
			loaded, err := loadLiveProjectCatalog(command.Context(), dependencies)
			if err != nil {
				return err
			}
			result := buildProjectListResult(loaded.Catalog)
			if format == "json" {
				encoder := json.NewEncoder(command.OutOrStdout())
				encoder.SetIndent("", "  ")
				return encoder.Encode(result)
			}
			return writeProjectList(command.OutOrStdout(), result)
		},
	}
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	must(command.RegisterFlagCompletionFunc(
		"format",
		fixedValuesCompletion("text", "json"),
	))
	return command
}

func newProjectPathCommand() *cobra.Command {
	return newProjectPathCommandWithDependencies(defaultProjectCommandsDependencies())
}

func newProjectPathCommandWithDependencies(
	dependencies projectCommandsDependencies,
) *cobra.Command {
	format := "path"
	command := &cobra.Command{
		Use:   "path <project>",
		Short: "Print a project's canonical local path",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if format != "path" && format != "json" {
				return errors.New("--format must be path or json")
			}
			project, path, err := loadLocalProject(
				command.Context(),
				dependencies,
				args[0],
			)
			if err != nil {
				return err
			}
			if format == "path" {
				_, err = fmt.Fprintln(command.OutOrStdout(), path)
				return err
			}
			result := newProjectPathResult(project, path)
			encoder := json.NewEncoder(command.OutOrStdout())
			encoder.SetIndent("", "  ")
			return encoder.Encode(result)
		},
	}
	command.Flags().StringVar(&format, "format", "path", "output format: path or json")
	must(command.RegisterFlagCompletionFunc(
		"format",
		fixedValuesCompletion("path", "json"),
	))
	command.ValidArgsFunction = projectSelectorCompletion(dependencies)
	return command
}

func newProjectOpenCommand() *cobra.Command {
	return newProjectOpenCommandWithDependencies(defaultProjectCommandsDependencies())
}

func newProjectOpenCommandWithDependencies(
	dependencies projectCommandsDependencies,
) *cobra.Command {
	format := "text"
	command := &cobra.Command{
		Use:   "open <project>",
		Short: "Open a local project in the system's selected terminal",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			if format != "text" && format != "json" {
				return errors.New("--format must be text or json")
			}
			if dependencies.Launcher == nil {
				return errors.New("terminal launcher is unavailable")
			}
			project, path, err := loadLocalProject(
				command.Context(),
				dependencies,
				args[0],
			)
			if err != nil {
				return err
			}
			launched, err := dependencies.Launcher.Open(command.Context(), path)
			if err != nil {
				return err
			}
			result := projectOpenResult{
				Launcher:      launched.Launcher,
				Path:          path,
				Project:       projectResultIdentity(project),
				SchemaVersion: 1,
				Selection:     launched.Selection,
			}
			if format == "json" {
				encoder := json.NewEncoder(command.OutOrStdout())
				encoder.SetIndent("", "  ")
				return encoder.Encode(result)
			}
			_, err = fmt.Fprintf(
				command.OutOrStdout(),
				"Opened %s in %s (%s) at %s\n",
				project.Repository,
				result.Launcher,
				result.Selection,
				result.Path,
			)
			return err
		},
	}
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	must(command.RegisterFlagCompletionFunc(
		"format",
		fixedValuesCompletion("text", "json"),
	))
	command.ValidArgsFunction = projectSelectorCompletion(dependencies)
	return command
}

func loadLiveProjectCatalog(
	ctx context.Context,
	dependencies projectCommandsDependencies,
) (projectCatalogLoad, error) {
	if dependencies.LoadCatalog == nil {
		return projectCatalogLoad{}, errors.New("project catalog is unavailable")
	}
	loaded, err := dependencies.LoadCatalog(ctx, false)
	if err != nil {
		return projectCatalogLoad{}, err
	}
	if loaded.Catalog.Catalog.Status != "connected" {
		message := loaded.Catalog.Catalog.Message
		if message == "" {
			message = "status is " + loaded.Catalog.Catalog.Status
		}
		return projectCatalogLoad{}, fmt.Errorf("project catalog is unavailable: %s", message)
	}
	return loaded, nil
}

func loadLocalProject(
	ctx context.Context,
	dependencies projectCommandsDependencies,
	selector string,
) (projectcatalog.Project, string, error) {
	loaded, err := loadLiveProjectCatalog(ctx, dependencies)
	if err != nil {
		return projectcatalog.Project{}, "", err
	}
	project, err := resolveProjectSelector(loaded.Catalog.Projects, selector)
	if err != nil {
		return projectcatalog.Project{}, "", err
	}
	localPaths, _ := canonicalProjectPaths(project)
	switch len(localPaths) {
	case 0:
		return projectcatalog.Project{}, "", fmt.Errorf(
			"%s is not checked out locally on this machine",
			project.Repository,
		)
	case 1:
		return project, localPaths[0], nil
	default:
		return projectcatalog.Project{}, "", fmt.Errorf(
			"%s has multiple local checkouts; choose one explicitly after resolving this ambiguity: %s",
			project.Repository,
			strings.Join(localPaths, ", "),
		)
	}
}

func resolveProjectSelector(
	projects []projectcatalog.Project,
	selector string,
) (projectcatalog.Project, error) {
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return projectcatalog.Project{}, errors.New("project selector is empty")
	}
	for _, project := range projects {
		if project.ID == selector {
			return project, nil
		}
	}
	for _, project := range projects {
		if strings.EqualFold(project.Repository, selector) {
			return project, nil
		}
	}
	matches := make([]projectcatalog.Project, 0)
	for _, project := range projects {
		if strings.EqualFold(project.DisplayName, selector) {
			matches = append(matches, project)
		}
	}
	switch len(matches) {
	case 0:
		return projectcatalog.Project{}, fmt.Errorf("project %q was not found", selector)
	case 1:
		return matches[0], nil
	default:
		choices := make([]string, len(matches))
		for index, project := range matches {
			choices[index] = fmt.Sprintf("%s (%s)", project.Repository, project.ID)
		}
		sort.Strings(choices)
		return projectcatalog.Project{}, fmt.Errorf(
			"project name %q is ambiguous; use one of: %s",
			selector,
			strings.Join(choices, ", "),
		)
	}
}

func canonicalProjectPaths(project projectcatalog.Project) ([]string, []string) {
	reported := make([]string, 0, len(project.LocalCandidates))
	valid := make([]string, 0, len(project.LocalCandidates))
	seenReported := make(map[string]struct{}, len(project.LocalCandidates))
	seenValid := make(map[string]struct{}, len(project.LocalCandidates))
	for _, candidate := range project.LocalCandidates {
		reportedPath := filepath.Clean(candidate.Path)
		if _, exists := seenReported[reportedPath]; !exists {
			reported = append(reported, reportedPath)
			seenReported[reportedPath] = struct{}{}
		}
		if !filepath.IsAbs(candidate.Path) {
			continue
		}
		resolved, err := filepath.EvalSymlinks(candidate.Path)
		if err != nil {
			continue
		}
		resolved, err = filepath.Abs(resolved)
		if err != nil {
			continue
		}
		info, err := os.Stat(resolved)
		if err != nil || !info.IsDir() {
			continue
		}
		resolved = filepath.Clean(resolved)
		if _, exists := seenValid[resolved]; !exists {
			valid = append(valid, resolved)
			seenValid[resolved] = struct{}{}
		}
	}
	sort.Strings(reported)
	sort.Strings(valid)
	return valid, reported
}

func buildProjectListResult(catalog projectcatalog.Catalog) projectListResult {
	projects := make([]projectListItem, 0, len(catalog.Projects))
	for _, project := range catalog.Projects {
		localPaths, reportedPaths := canonicalProjectPaths(project)
		var localPath *string
		if len(localPaths) == 1 {
			path := localPaths[0]
			localPath = &path
		}
		projects = append(projects, projectListItem{
			ID:             project.ID,
			LocalAvailable: len(localPaths) > 0,
			LocalPath:      localPath,
			LocalPaths:     localPaths,
			Name:           project.DisplayName,
			ReportedPaths:  reportedPaths,
			Repository:     project.Repository,
		})
	}
	return projectListResult{
		Projects:      projects,
		SchemaVersion: 1,
		Source: projectListSource{
			CacheState: catalog.Catalog.CacheState,
			CheckedAt:  catalog.Catalog.CheckedAt,
			Status:     catalog.Catalog.Status,
		},
	}
}

func writeProjectList(output io.Writer, result projectListResult) error {
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(writer, "NAME\tREPOSITORY\tLOCAL\tPATH"); err != nil {
		return err
	}
	for _, project := range result.Projects {
		available := "no"
		path := "—"
		if project.LocalAvailable {
			available = "yes"
			if project.LocalPath != nil {
				path = *project.LocalPath
			} else {
				path = fmt.Sprintf("%d local checkouts", len(project.LocalPaths))
			}
		} else if len(project.ReportedPaths) > 0 {
			path = "missing: " + strings.Join(project.ReportedPaths, ", ")
		}
		if _, err := fmt.Fprintf(
			writer,
			"%s\t%s\t%s\t%s\n",
			project.Name,
			project.Repository,
			available,
			path,
		); err != nil {
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	if result.Source.CacheState != "" && result.Source.CacheState != "fresh" {
		_, err := fmt.Fprintf(
			output,
			"Catalog source: %s (checked %s)\n",
			result.Source.CacheState,
			result.Source.CheckedAt,
		)
		return err
	}
	return nil
}

func newProjectPathResult(
	project projectcatalog.Project,
	path string,
) projectPathResult {
	result := projectPathResult{Path: path, SchemaVersion: 1}
	result.Project = projectResultIdentity(project)
	return result
}

func projectResultIdentity(project projectcatalog.Project) projectPathResultProject {
	return projectPathResultProject{
		ID:         project.ID,
		Name:       project.DisplayName,
		Repository: project.Repository,
	}
}

func projectSelectorCompletion(
	dependencies projectCommandsDependencies,
) func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return func(
		command *cobra.Command,
		args []string,
		_ string,
	) ([]string, cobra.ShellCompDirective) {
		if len(args) > 0 || dependencies.LoadCatalog == nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		loaded, err := dependencies.LoadCatalog(command.Context(), true)
		if err != nil || loaded.Catalog.Catalog.Status != "connected" {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		nameCounts := make(map[string]int, len(loaded.Catalog.Projects))
		for _, project := range loaded.Catalog.Projects {
			nameCounts[strings.ToLower(project.DisplayName)]++
		}
		values := make([]string, 0, len(loaded.Catalog.Projects))
		for _, project := range loaded.Catalog.Projects {
			selector := project.Repository
			if nameCounts[strings.ToLower(project.DisplayName)] == 1 {
				selector = project.DisplayName
			}
			description := project.Repository
			if loaded.Cached {
				description += " (cached; local availability unverified)"
			} else {
				localPaths, _ := canonicalProjectPaths(project)
				switch len(localPaths) {
				case 0:
					description += " (remote only)"
				case 1:
					description += " (" + localPaths[0] + ")"
				default:
					description += fmt.Sprintf(" (%d local checkouts)", len(localPaths))
				}
			}
			values = append(values, selector+"\t"+description)
		}
		return values, cobra.ShellCompDirectiveNoFileComp
	}
}
