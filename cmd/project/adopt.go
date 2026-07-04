package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/DotNaos/project-space/internal/projectvalidator"
	"github.com/spf13/cobra"
)

func newAdoptCommand() *cobra.Command {
	dryRun := false
	format := "pretty"
	reason := ""
	waive := ""
	yes := false
	cmd := &cobra.Command{
		Use:               "adopt [directory]",
		Short:             "Plan adoption of an existing project",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			if format != "pretty" && format != "json" {
				return fmt.Errorf("unknown format %q; use pretty or json", format)
			}
			if format == "json" && waive != "" && !dryRun && !yes {
				return fmt.Errorf("use --dry-run or --yes with --format json")
			}
			target := "."
			if len(args) == 1 {
				target = args[0]
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			if waive != "" {
				if reason == "" {
					return fmt.Errorf("--waive requires --reason")
				}
				plan, err := projectvalidator.AddAdoptionWaiver(resolved, waive, reason, projectvalidator.AdoptionWaiverOptions{})
				if err != nil {
					return err
				}
				if dryRun || plan.AlreadyExists || !plan.WouldWrite {
					return printAdoptionWaiverPlan(cmd, plan, format)
				}
				if !yes {
					if err := printAdoptionWaiverPlan(cmd, plan, format); err != nil {
						return err
					}
					confirmed, err := confirmApply(cmd)
					if err != nil {
						return err
					}
					if !confirmed {
						printModuleCanceled(cmd, formatForModuleCancel(format))
						return nil
					}
				}
				applied, err := projectvalidator.AddAdoptionWaiver(resolved, waive, reason, projectvalidator.AdoptionWaiverOptions{Apply: true})
				if err != nil {
					return err
				}
				return printAdoptionWaiverApplied(cmd, applied, format)
			}
			plan, err := projectvalidator.PlanAdoption(resolved)
			if err != nil {
				return err
			}
			return printAdoptionPlan(cmd, plan, format)
		},
	}
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "show the adoption plan without writing changes")
	cmd.Flags().StringVar(&format, "format", "pretty", "output format")
	cmd.Flags().StringVar(&reason, "reason", "", "reason for a waiver")
	cmd.Flags().StringVar(&waive, "waive", "", "add a waiver for a path pattern")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "apply the adoption action without prompting")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "json")))
	return cmd
}

func formatForModuleCancel(format string) string {
	if format == "json" {
		return "pretty"
	}
	return format
}

func printAdoptionPlan(cmd *cobra.Command, plan projectvalidator.AdoptionPlan, format string) error {
	if format == "json" {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(plan)
	}

	fmt.Fprintln(cmd.OutOrStdout(), "Adoption plan")
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", plan.ProjectRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Template: %s\n", plan.TemplateLabel)
	fmt.Fprintln(cmd.OutOrStdout(), "Mode: dry-run")
	fmt.Fprintf(cmd.OutOrStdout(), "Summary: %d match, %d slot, %d blocker, %d waived, %d missing, %d drift, %d unknown\n\n",
		plan.Summary.Match,
		plan.Summary.Slot,
		plan.Summary.Blocker,
		plan.Summary.Waived,
		plan.Summary.Missing,
		plan.Summary.Drift,
		plan.Summary.Unknown,
	)

	fmt.Fprintln(cmd.OutOrStdout(), "Modules")
	for _, module := range plan.Modules {
		status := "not adopted"
		if module.Adopted {
			status = "adopted"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "  %s  %s  %d match, %d blocker, %d waived, %d missing, %d drift\n",
			module.Name,
			status,
			module.Summary.Match,
			module.Summary.Blocker,
			module.Summary.Waived,
			module.Summary.Missing,
			module.Summary.Drift,
		)
	}
	if len(plan.Modules) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "  no modules")
	}

	fmt.Fprintln(cmd.OutOrStdout(), "\nFiles")
	for _, file := range plan.Files {
		detail := file.Module
		if detail == "" {
			detail = file.Slot
		}
		if detail == "" {
			detail = file.Note
		}
		fmt.Fprintf(cmd.OutOrStdout(), "  %-8s %-48s %s\n", file.State, file.Path, detail)
	}
	if len(plan.Files) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "  no files")
	}

	fmt.Fprintln(cmd.OutOrStdout(), "\nResult: dry run, no changes written")
	return nil
}

func printAdoptionWaiverPlan(cmd *cobra.Command, plan projectvalidator.AdoptionWaiverPlan, format string) error {
	if format == "json" {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(plan)
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Adoption waiver plan")
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", plan.ProjectRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Path: %s\n", plan.Path)
	fmt.Fprintf(cmd.OutOrStdout(), "Reason: %s\n", plan.Reason)
	if plan.AlreadyExists {
		fmt.Fprintln(cmd.OutOrStdout(), "Result: waiver already exists")
		return nil
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Result: waiting for confirmation")
	return nil
}

func printAdoptionWaiverApplied(cmd *cobra.Command, plan projectvalidator.AdoptionWaiverPlan, format string) error {
	if format == "json" {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(plan)
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Result: waiver added")
	fmt.Fprintf(cmd.OutOrStdout(), "Lock: %s\n", plan.LockPath)
	return nil
}
