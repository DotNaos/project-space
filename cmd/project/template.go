package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/DotNaos/project-space/internal/projectvalidator"
	"github.com/spf13/cobra"
)

func newTemplateCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "template",
		Short: "Manage the local project template snapshot",
	}
	cmd.AddCommand(newTemplateLintCommand())
	cmd.AddCommand(newTemplateSyncCommand())
	cmd.AddCommand(newTemplateUpdateCommand())
	cmd.AddCommand(newTemplateSmokeCommand())
	return cmd
}

func newTemplateUpdateCommand() *cobra.Command {
	options := projectvalidator.TemplateUpdateOptions{}
	format := "pretty"
	yes := false
	targets := []string{}
	cmd := &cobra.Command{
		Use:               "update [directory]",
		Short:             "Update a project from its template",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			target := "."
			if len(args) == 1 {
				target = args[0]
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			if format != "pretty" && format != "tsv" {
				return fmt.Errorf("unknown format %q; use pretty or tsv", format)
			}
			if yes && options.DryRun {
				return fmt.Errorf("--yes and --dry-run cannot be used together")
			}
			if format == "tsv" && !options.DryRun && !yes {
				return fmt.Errorf("use --dry-run or --yes with --format tsv")
			}
			selections, err := parseAppTargetSelections(targets)
			if err != nil {
				return err
			}
			options.Targets = selections
			plan, err := projectvalidator.PlanTemplateUpdate(resolved, options)
			if err != nil {
				return err
			}
			printTemplateUpdatePlan(cmd, plan, format, options.DryRun)
			if options.DryRun || !plan.WouldWrite {
				return nil
			}
			if !yes {
				confirmed, err := confirmApply(cmd)
				if err != nil {
					return err
				}
				if !confirmed {
					printTemplateUpdateCanceled(cmd, format)
					return nil
				}
			}
			applied, err := projectvalidator.ApplyTemplateUpdate(resolved, options)
			if err != nil {
				return err
			}
			printTemplateUpdateApplied(cmd, applied, format)
			report, err := projectvalidator.ValidateProject(resolved)
			if err != nil {
				return err
			}
			printTemplateUpdateValidation(cmd, report, format)
			return nil
		},
	}
	cmd.Flags().BoolVar(&options.DryRun, "dry-run", false, "show the template update plan without writing changes")
	cmd.Flags().StringVar(&format, "format", "pretty", "output format")
	cmd.Flags().StringVar(&options.TemplatePath, "template-path", "", "template source path")
	cmd.Flags().StringArrayVar(&targets, "target", nil, "app target and devices for legacy module migration (<target>:<device>[,<device>...])")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "apply the template update without prompting")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "tsv")))
	must(cmd.RegisterFlagCompletionFunc("template-path", directoryCompletion))
	return cmd
}

func printTemplateUpdatePlan(cmd *cobra.Command, plan projectvalidator.TemplateUpdatePlan, format string, dryRun bool) {
	if format == "tsv" {
		mode := "apply"
		if dryRun {
			mode = "dry_run"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "PLAN\ttemplate_update\t%s\t%s\n", mode, plan.ProjectRoot)
		fmt.Fprintf(cmd.OutOrStdout(), "FROM\ttemplate\t%s\t%s\n", plan.FromTemplate, plan.FromVersion)
		fmt.Fprintf(cmd.OutOrStdout(), "TO\ttemplate\t%s\t%s\n", plan.ToTemplate, plan.ToVersion)
		fmt.Fprintf(cmd.OutOrStdout(), "MODULES\tmodules\t%s\t%s\n", strings.Join(plan.FromModules, ","), strings.Join(plan.ToModules, ","))
		fmt.Fprintf(cmd.OutOrStdout(), "SOURCE\tdir\t%s\t.\n", plan.SourceRoot)
		fmt.Fprintf(cmd.OutOrStdout(), "CONFLICTS\tdir\t%s\t.\n", plan.ConflictFolder)
		for _, value := range plan.Values {
			fmt.Fprintf(cmd.OutOrStdout(), "%s\tvalue\t%s\t%s\t%s\n", value.Action, value.Key, tsvValue(value.Before), tsvValue(value.After))
		}
		for _, file := range plan.Files {
			fmt.Fprintf(cmd.OutOrStdout(), "%s\tfile\t%s\t%s\t%s\n", file.Action, file.Path, file.Result, file.Module)
		}
		if !plan.WouldWrite {
			fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tok\t.\tno changes")
			return
		}
		if dryRun {
			fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tdry_run\t.\tno changes written")
			return
		}
		fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tplanned\t.\tready to apply")
		return
	}

	fmt.Fprintln(cmd.OutOrStdout(), "Template update plan")
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", plan.ProjectRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Source: %s\n", plan.SourceRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "From: %s@%s\n", plan.FromTemplate, prettyValue(plan.FromVersion))
	fmt.Fprintf(cmd.OutOrStdout(), "To: %s@%s\n", plan.ToTemplate, prettyValue(plan.ToVersion))
	if plan.FromCommit != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Current commit: %s\n", plan.FromCommit)
	}
	if plan.FromChecksum != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Current checksum: %s\n", plan.FromChecksum)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Target checksum: %s\n", plan.ToChecksum)
	if len(plan.FromModules) > 0 || len(plan.ToModules) > 0 {
		fmt.Fprintf(cmd.OutOrStdout(), "Modules: %s -> %s\n", strings.Join(plan.FromModules, ", "), strings.Join(plan.ToModules, ", "))
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Conflict folder: %s\n", plan.ConflictFolder)
	mode := "apply"
	if dryRun {
		mode = "dry-run"
	}
	if !plan.WouldWrite {
		mode = "none"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Mode: %s\n", mode)

	fmt.Fprintln(cmd.OutOrStdout(), "\nValues")
	if len(plan.Values) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "  no value changes")
	} else {
		writer := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
		fmt.Fprintln(writer, "  CHANGE\tKEY\tBEFORE\tAFTER")
		for _, value := range plan.Values {
			fmt.Fprintf(writer, "  %s\t%s\t%s\t%s\n", coloredTemplateUpdateAction(value.Action), value.Key, prettyDash(value.Before), prettyDash(value.After))
		}
		writer.Flush()
	}

	fmt.Fprintln(cmd.OutOrStdout(), "\nFiles")
	if len(plan.Files) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "  no file changes")
	} else {
		writer := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
		fmt.Fprintln(writer, "  CHANGE\tPATH\tRESULT\tMODULE")
		for _, file := range plan.Files {
			fmt.Fprintf(writer, "  %s\t%s\t%s\t%s\n", coloredTemplateUpdateAction(file.Action), file.Path, coloredTemplateUpdateResult(file.Result), prettyDash(file.Module))
		}
		writer.Flush()
	}

	if !plan.WouldWrite {
		fmt.Fprintln(cmd.OutOrStdout(), "\nResult: no changes")
		return
	}
	if dryRun {
		fmt.Fprintln(cmd.OutOrStdout(), "\nResult: dry run, no changes written")
		return
	}
	fmt.Fprintln(cmd.OutOrStdout(), "\nResult: ready to apply")
}

func printTemplateUpdateApplied(cmd *cobra.Command, plan projectvalidator.TemplateUpdatePlan, format string) {
	if format == "tsv" {
		fmt.Fprintf(cmd.OutOrStdout(), "RESULT\tapplied\t.\t%s\n", plan.ProjectRoot)
		if hasTemplateUpdateConflicts(plan) {
			fmt.Fprintf(cmd.OutOrStdout(), "CONFLICTS\twritten\t%s\t.\n", plan.ConflictFolder)
		}
		return
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Applied template update to %s\n", plan.ProjectRoot)
	if hasTemplateUpdateConflicts(plan) {
		fmt.Fprintf(cmd.OutOrStdout(), "Conflicts need review in %s\n", plan.ConflictFolder)
	}
}

func printTemplateUpdateValidation(cmd *cobra.Command, report projectvalidator.Report, format string) {
	failures := countValidationFailures(report)
	if format == "tsv" {
		status := "ok"
		if !report.OK {
			status = "failed"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "VALIDATE\t%s\t%d\t%s\n", status, failures, report.ProjectRoot)
		return
	}
	if report.OK {
		fmt.Fprintln(cmd.OutOrStdout(), "Validation: ok")
		return
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Validation: failed (%d issues)\n", failures)
}

func countValidationFailures(report projectvalidator.Report) int {
	count := 0
	for _, file := range report.Files {
		if file.Status == projectvalidator.StatusMissing || file.Status == projectvalidator.StatusViolation {
			count++
		}
	}
	for _, entry := range report.Structure {
		if entry.Status == projectvalidator.StatusMissing || entry.Status == projectvalidator.StatusViolation {
			count++
		}
	}
	return count
}

func printTemplateUpdateCanceled(cmd *cobra.Command, format string) {
	if format == "tsv" {
		fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tcanceled\t.\tno changes written")
		return
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Result: canceled, no changes written")
}

func hasTemplateUpdateConflicts(plan projectvalidator.TemplateUpdatePlan) bool {
	for _, file := range plan.Files {
		if file.Result == "conflict" {
			return true
		}
	}
	return false
}

func coloredTemplateUpdateAction(action string) string {
	switch action {
	case "ADD":
		return cliColor(action, "blue")
	case "CHANGE", "UPDATE":
		return cliColor(action, "yellow")
	case "REMOVE":
		return cliColor(action, "red")
	default:
		return action
	}
}

func coloredTemplateUpdateResult(result string) string {
	switch result {
	case "clean":
		return cliColor(result, "green")
	case "merged":
		return cliColor(result, "blue")
	case "conflict":
		return cliColor(result, "red")
	case "missing":
		return cliColor(result, "yellow")
	default:
		return result
	}
}

func prettyDash(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func tsvValue(value string) string {
	if value == "" {
		return "."
	}
	return value
}

func cliColor(value string, colorName string) string {
	if os.Getenv("NO_COLOR") != "" {
		return value
	}
	codes := map[string]string{
		"green":  "38;2;52;211;153",
		"blue":   "38;2;96;165;250",
		"yellow": "38;2;245;158;11",
		"red":    "38;2;248;113;113",
	}
	code, ok := codes[colorName]
	if !ok {
		return value
	}
	return "\x1b[" + code + "m" + value + "\x1b[0m"
}

func newTemplateSyncCommand() *cobra.Command {
	options := projectvalidator.TemplateSyncOptions{}
	format := "pretty"
	cmd := &cobra.Command{
		Use:               "sync [directory]",
		Short:             "Sync the local template snapshot",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			target := "."
			if len(args) == 1 {
				target = args[0]
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			if format != "pretty" && format != "tsv" {
				return fmt.Errorf("unknown format %q; use pretty or tsv", format)
			}
			if options.DryRun {
				plan, err := projectvalidator.PlanTemplateSync(resolved, options)
				if err != nil {
					return err
				}
				printTemplateSyncPlan(cmd, plan, options, format)
				return nil
			}
			templatePath, checksum, err := projectvalidator.SyncTemplate(resolved, options)
			if err != nil {
				return err
			}
			if format == "tsv" {
				fmt.Fprintf(cmd.OutOrStdout(), "RESULT\tapplied\t%s\t%s\n", templatePath, checksum)
				return nil
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Synced project template: %s\n", templatePath)
			fmt.Fprintf(cmd.OutOrStdout(), "Checksum: %s\n", checksum)
			return nil
		},
	}
	cmd.Flags().BoolVar(&options.DryRun, "dry-run", false, "show the template sync plan without writing changes")
	cmd.Flags().StringVar(&format, "format", "pretty", "output format")
	cmd.Flags().StringVar(&options.TemplatePath, "template-path", "", "template source path")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "tsv")))
	must(cmd.RegisterFlagCompletionFunc("template-path", directoryCompletion))
	return cmd
}

func printTemplateSyncPlan(cmd *cobra.Command, plan projectvalidator.TemplateSyncPlan, options projectvalidator.TemplateSyncOptions, format string) {
	if format == "tsv" {
		fmt.Fprintf(cmd.OutOrStdout(), "PLAN\ttemplate_sync\tdry_run\t%s\n", plan.ProjectRoot)
		fmt.Fprintf(cmd.OutOrStdout(), "SOURCE\tdir\t%s\t.\n", plan.SourceRoot)
		fmt.Fprintf(cmd.OutOrStdout(), "TARGET\tdir\t%s\t.\n", plan.TargetRoot)
		fmt.Fprintf(cmd.OutOrStdout(), "CHECKSUM\ttemplate\t%s\t.\n", plan.Checksum)
		for _, file := range plan.Files {
			fmt.Fprintf(cmd.OutOrStdout(), "%s\tfile\t%s\t.\n", file.Action, file.Path)
		}
		if !plan.WouldWrite {
			fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tok\t.\tno changes")
			return
		}
		fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tdry_run\t.\tno changes written")
		return
	}

	fmt.Fprintln(cmd.OutOrStdout(), "Template sync plan")
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", plan.ProjectRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Source: %s\n", plan.SourceRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Target: %s\n", plan.TargetRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Checksum: %s\n", plan.Checksum)
	if options.TemplatePath != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Template path override: %s\n", options.TemplatePath)
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Mode: dry-run")

	fmt.Fprintln(cmd.OutOrStdout(), "\nFiles")
	for _, file := range plan.Files {
		fmt.Fprintf(cmd.OutOrStdout(), "  %s %s\n", file.Action, file.Path)
	}
	if len(plan.Files) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "  no file changes")
	}

	if !plan.WouldWrite {
		fmt.Fprintln(cmd.OutOrStdout(), "\nResult: no changes")
		return
	}
	fmt.Fprintln(cmd.OutOrStdout(), "\nResult: dry run, no changes written")
}
