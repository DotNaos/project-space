package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/DotNaos/project-space/internal/projectcatalog"
	"github.com/DotNaos/project-space/internal/projectstorage"
	"github.com/spf13/cobra"
)

type storageAuditor func(context.Context, string, string, string, projectstorage.Options) (projectstorage.Report, error)

type storageCommandDependencies struct {
	Audit         storageAuditor
	DiscoverLocal localProjectDiscovery
	LoadCatalog   projectCatalogLoader
	Now           func() time.Time
}

type storageAuditProject struct {
	Complete       bool                   `json:"complete"`
	Error          string                 `json:"error,omitempty"`
	LocalAvailable bool                   `json:"localAvailable"`
	Name           string                 `json:"name"`
	ProjectID      string                 `json:"projectId"`
	Repository     string                 `json:"repository"`
	Storage        *projectstorage.Report `json:"storage,omitempty"`
}

type storageAuditResult struct {
	CheckedAt     string                `json:"checkedAt"`
	Complete      bool                  `json:"complete"`
	Projects      []storageAuditProject `json:"projects"`
	SchemaVersion int                   `json:"schemaVersion"`
	TotalBytes    int64                 `json:"totalBytes"`
}

func newStorageCommand() *cobra.Command {
	return newStorageCommandWithDependencies(storageCommandDependencies{
		Audit: projectstorage.Audit, DiscoverLocal: discoverLocalProjectPaths,
		LoadCatalog: loadProjectCatalog, Now: time.Now,
	})
}

func newStorageCommandWithDependencies(dependencies storageCommandDependencies) *cobra.Command {
	command := &cobra.Command{Use: "storage", Short: "Audit local project storage", Args: cobra.NoArgs}
	command.AddCommand(newStorageAuditCommand(dependencies))
	return command
}

func newStorageAuditCommand(dependencies storageCommandDependencies) *cobra.Command {
	format, selector := "text", ""
	command := &cobra.Command{
		Use:   "audit",
		Short: "Measure account projects and their registered worktrees",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if format != "text" && format != "json" {
				return errors.New("--format must be text or json")
			}
			result, err := runStorageAudit(command.Context(), dependencies, selector)
			if err != nil {
				return err
			}
			if format == "json" {
				encoder := json.NewEncoder(command.OutOrStdout())
				encoder.SetIndent("", "  ")
				return encoder.Encode(result)
			}
			return writeStorageAudit(command.OutOrStdout(), result)
		},
	}
	command.Flags().StringVar(&selector, "project", "", "limit the audit to one project ID, repository, or unique name")
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	must(command.RegisterFlagCompletionFunc("format", fixedValuesCompletion("text", "json")))
	command.ValidArgsFunction = projectSelectorCompletion(projectCommandsDependencies{LoadCatalog: dependencies.LoadCatalog})
	return command
}

func runStorageAudit(ctx context.Context, dependencies storageCommandDependencies, selector string) (storageAuditResult, error) {
	if dependencies.LoadCatalog == nil || dependencies.Audit == nil {
		return storageAuditResult{}, errors.New("storage audit is unavailable")
	}
	loaded, err := loadLiveProjectCatalog(ctx, projectCommandsDependencies{LoadCatalog: dependencies.LoadCatalog})
	if err != nil {
		return storageAuditResult{}, err
	}
	projects := loaded.Catalog.Projects
	if strings.TrimSpace(selector) != "" {
		project, resolveErr := resolveProjectSelector(projects, selector)
		if resolveErr != nil {
			return storageAuditResult{}, resolveErr
		}
		projects = []projectcatalog.Project{project}
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	result := storageAuditResult{
		CheckedAt: now().UTC().Format(time.RFC3339Nano), Complete: true,
		Projects: make([]storageAuditProject, 0, len(projects)), SchemaVersion: 1,
	}
	discovered := map[string][]string{}
	if dependencies.DiscoverLocal != nil {
		discovered, err = dependencies.DiscoverLocal(ctx)
		if err != nil {
			return storageAuditResult{}, err
		}
	}
	for _, project := range projects {
		item := storageAuditProject{
			Complete: true, Name: project.DisplayName, ProjectID: project.ID,
			Repository: project.Repository,
		}
		paths := mergedLocalProjectPaths(project, discovered)
		switch len(paths) {
		case 0:
			item.LocalAvailable = false
		case 1:
			item.LocalAvailable = true
			report, auditErr := dependencies.Audit(ctx, project.ID, project.Repository, paths[0], projectstorage.Options{Now: now})
			if auditErr != nil {
				item.Complete = false
				item.Error = auditErr.Error()
			} else {
				item.Storage = &report
				item.Complete = report.Complete
				result.TotalBytes += report.TotalBytes
			}
		default:
			item.LocalAvailable = true
			item.Complete = false
			item.Error = "multiple local main checkouts require manual resolution"
		}
		if !item.Complete {
			result.Complete = false
		}
		result.Projects = append(result.Projects, item)
	}
	sort.Slice(result.Projects, func(i, j int) bool {
		left, right := int64(0), int64(0)
		if result.Projects[i].Storage != nil {
			left = result.Projects[i].Storage.TotalBytes
		}
		if result.Projects[j].Storage != nil {
			right = result.Projects[j].Storage.TotalBytes
		}
		if left != right {
			return left > right
		}
		return result.Projects[i].Repository < result.Projects[j].Repository
	})
	return result, nil
}

func writeStorageAudit(output io.Writer, result storageAuditResult) error {
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(writer, "PROJECT\tMAIN\tWORKTREES\tTOTAL\tSTATE"); err != nil {
		return err
	}
	for _, project := range result.Projects {
		main, worktrees, total, state := "—", "—", "—", "remote only"
		if project.Storage != nil {
			main = humanBytes(project.Storage.MainBytes)
			worktrees = humanBytes(project.Storage.WorktreeBytes)
			total = humanBytes(project.Storage.TotalBytes)
			state = "measured"
			if !project.Complete {
				state = "partial"
			}
		} else if project.Error != "" {
			state = "blocked: " + project.Error
		}
		if _, err := fmt.Fprintf(writer, "%s\t%s\t%s\t%s\t%s\n", project.Repository, main, worktrees, total, state); err != nil {
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	_, err := fmt.Fprintf(output, "Total measured: %s\n", humanBytes(result.TotalBytes))
	return err
}

func humanBytes(value int64) string {
	const unit = int64(1024)
	if value < unit {
		return fmt.Sprintf("%d B", value)
	}
	units := []string{"KiB", "MiB", "GiB", "TiB"}
	amount := float64(value)
	index := -1
	for amount >= float64(unit) && index < len(units)-1 {
		amount /= float64(unit)
		index++
	}
	return fmt.Sprintf("%.1f %s", amount, units[index])
}
