package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/DotNaos/project-space/internal/projectvalidator"
	"github.com/spf13/cobra"
)

func newValidateCommand() *cobra.Command {
	options := projectvalidator.DefaultOutputOptions()
	quarantine := false
	dryRun := false
	yes := false
	cmd := &cobra.Command{
		Use:               "validate [directory|file]",
		Short:             "Validate a project against its template",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: fileCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			target := ""
			if len(args) == 1 {
				target = args[0]
			}
			if quarantine {
				return validateAndQuarantine(cmd, target, options, projectvalidator.ViolationQuarantineOptions{Apply: yes, DryRun: dryRun})
			}
			return validate(target, options)
		},
	}
	cmd.Flags().StringVar((*string)(&options.Format), "format", string(projectvalidator.OutputFormatPretty), "output format")
	cmd.Flags().StringVar((*string)(&options.View), "view", string(projectvalidator.ViewModeTree), "pretty output view")
	cmd.Flags().StringVar((*string)(&options.ColorScope), "color-scope", string(projectvalidator.ColorScopeLine), "color scope")
	cmd.Flags().BoolVar(&quarantine, "quarantine", false, "move not_allowed validation violations into .project/quarantine")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "show the quarantine plan without writing changes")
	cmd.Flags().Bool("status-color-only", false, "color only the status text")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "apply the quarantine plan without prompting")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "tsv")))
	must(cmd.RegisterFlagCompletionFunc("view", fixedValuesCompletion("tree", "table")))
	must(cmd.RegisterFlagCompletionFunc("color-scope", fixedValuesCompletion("line", "status")))
	cmd.PreRunE = func(cmd *cobra.Command, args []string) error {
		if yes && dryRun {
			return fmt.Errorf("--yes and --dry-run cannot be used together")
		}
		if !quarantine && (yes || dryRun) {
			return fmt.Errorf("--yes and --dry-run require --quarantine")
		}
		if quarantine && options.Format == projectvalidator.OutputFormatTSV && !dryRun && !yes {
			return fmt.Errorf("use --dry-run or --yes with --quarantine --format tsv")
		}
		statusOnly, err := cmd.Flags().GetBool("status-color-only")
		if err != nil {
			return err
		}
		if statusOnly {
			options.ColorScope = projectvalidator.ColorScopeStatus
		}
		return validateOutputOptions(options)
	}
	return cmd
}

func validateAndQuarantine(cmd *cobra.Command, target string, options projectvalidator.OutputOptions, quarantineOptions projectvalidator.ViolationQuarantineOptions) error {
	projectRoot, err := resolveProjectDirectoryTarget(target)
	if err != nil {
		return err
	}
	report, err := projectvalidator.ValidateProject(projectRoot)
	if err != nil {
		return err
	}
	plan := projectvalidator.PlanViolationQuarantine(report)
	printViolationQuarantinePlan(cmd, plan, quarantineOptions, options.Format)
	if quarantineOptions.DryRun || len(plan.Files) == 0 {
		return nil
	}
	if !quarantineOptions.Apply {
		confirmed, err := confirmApply(cmd)
		if err != nil {
			return err
		}
		if !confirmed {
			printQuarantineCanceled(cmd, options.Format)
			return nil
		}
	}
	applied, err := projectvalidator.ApplyViolationQuarantine(plan)
	if err != nil {
		return err
	}
	printQuarantineApplied(cmd, applied, options.Format)
	return nil
}

func resolveProjectDirectoryTarget(target string) (string, error) {
	if target == "" {
		return filepath.Abs(".")
	}
	resolved, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	stat, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !stat.IsDir() {
		return "", fmt.Errorf("--quarantine only supports project directories")
	}
	return resolved, nil
}

func printViolationQuarantinePlan(cmd *cobra.Command, plan projectvalidator.ViolationQuarantinePlan, options projectvalidator.ViolationQuarantineOptions, format projectvalidator.OutputFormat) {
	if format == projectvalidator.OutputFormatTSV {
		mode := "confirm"
		if options.DryRun {
			mode = "dry_run"
		} else if options.Apply {
			mode = "apply"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "PLAN\tviolation_quarantine\t%s\t%s\n", mode, plan.ProjectRoot)
		fmt.Fprintf(cmd.OutOrStdout(), "TARGET\tdir\t%s\t.\n", plan.QuarantineRoot)
		for _, file := range plan.Files {
			module := file.Module
			if module == "" {
				module = "-"
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s\tfile\t%s\t%s\t%s\t%s\n", file.Action, file.OriginalPath, file.QuarantinePath, file.Code, module)
		}
		if len(plan.Files) == 0 {
			fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tok\t.\tno quarantinable violations")
			return
		}
		if options.DryRun {
			fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tdry_run\t.\tno changes written")
			return
		}
		if options.Apply {
			fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tapply\t.\tapplying")
			return
		}
		fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tconfirm\t.\twaiting for confirmation")
		return
	}

	mode := "confirm"
	if options.DryRun {
		mode = "dry-run"
	} else if options.Apply {
		mode = "apply"
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Violation quarantine plan")
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", plan.ProjectRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Target: %s\n", plan.QuarantineRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Mode: %s\n\n", mode)

	fmt.Fprintln(cmd.OutOrStdout(), "Files")
	for _, file := range plan.Files {
		fmt.Fprintf(cmd.OutOrStdout(), "  %s %s -> %s\n", file.Action, file.OriginalPath, file.QuarantinePath)
	}
	if len(plan.Files) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "  no quarantinable violations")
		fmt.Fprintln(cmd.OutOrStdout(), "\nResult: no changes")
		return
	}
	if options.DryRun {
		fmt.Fprintln(cmd.OutOrStdout(), "\nResult: dry run, no changes written")
		return
	}
	if options.Apply {
		fmt.Fprintln(cmd.OutOrStdout(), "\nResult: applying")
		return
	}
	fmt.Fprintln(cmd.OutOrStdout(), "\nResult: waiting for confirmation")
}

func printQuarantineApplied(cmd *cobra.Command, plan projectvalidator.ViolationQuarantinePlan, format projectvalidator.OutputFormat) {
	if format == projectvalidator.OutputFormatTSV {
		fmt.Fprintf(cmd.OutOrStdout(), "RESULT\tapplied\t%s\tmanifest written\n", plan.ManifestPath)
		return
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Result: applied\nManifest: %s\n", plan.ManifestPath)
}

func printQuarantineCanceled(cmd *cobra.Command, format projectvalidator.OutputFormat) {
	if format == projectvalidator.OutputFormatTSV {
		fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tcanceled\t.\tno changes written")
		return
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Result: canceled, no changes written")
}

func validate(target string, options projectvalidator.OutputOptions) error {
	if target != "" {
		resolved, err := filepath.Abs(target)
		if err != nil {
			return err
		}
		if stat, err := os.Stat(resolved); err == nil && stat.IsDir() {
			report, err := projectvalidator.ValidateProject(resolved)
			if err != nil {
				return err
			}
			projectvalidator.PrintProjectReportWithOptions(report, options)
			if !report.OK {
				os.Exit(1)
			}
			return nil
		}
		if stat, err := os.Stat(resolved); err == nil && !stat.IsDir() {
			relative, err := filepath.Rel(mustGetwd(), resolved)
			if err != nil {
				return err
			}
			report, err := projectvalidator.ValidateProjectFile(mustGetwd(), relative)
			if err != nil {
				return err
			}
			projectvalidator.PrintFileReportWithOptions(report, options)
			if report.Status == projectvalidator.StatusMissing || report.Status == projectvalidator.StatusViolation {
				os.Exit(1)
			}
			return nil
		}
	}
	report, err := projectvalidator.ValidateProject(mustGetwd())
	if err != nil {
		return err
	}
	projectvalidator.PrintProjectReportWithOptions(report, options)
	if !report.OK {
		os.Exit(1)
	}
	return nil
}

func validateOutputOptions(options projectvalidator.OutputOptions) error {
	switch options.Format {
	case projectvalidator.OutputFormatPretty, projectvalidator.OutputFormatTSV:
	default:
		return fmt.Errorf("unknown format %q; use pretty or tsv", options.Format)
	}
	switch options.View {
	case projectvalidator.ViewModeTree, projectvalidator.ViewModeTable:
	default:
		return fmt.Errorf("unknown view %q; use tree or table", options.View)
	}
	switch options.ColorScope {
	case projectvalidator.ColorScopeLine, projectvalidator.ColorScopeStatus:
	default:
		return fmt.Errorf("unknown color scope %q; use line or status", options.ColorScope)
	}
	return nil
}
