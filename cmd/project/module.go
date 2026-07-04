package main

import (
	"bufio"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/DotNaos/project-space/internal/projectvalidator"
	"github.com/spf13/cobra"
)

func newModuleCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "module",
		Short: "Manage project template modules",
	}
	cmd.AddCommand(newModuleListCommand())
	cmd.AddCommand(newModuleShowCommand())
	cmd.AddCommand(newModuleAddCommand())
	cmd.AddCommand(newModuleRemoveCommand())
	return cmd
}

func newModuleListCommand() *cobra.Command {
	format := "pretty"
	cmd := &cobra.Command{
		Use:               "list [directory]",
		Short:             "List project template modules",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			if format != "pretty" && format != "tsv" {
				return fmt.Errorf("unknown format %q; use pretty or tsv", format)
			}
			target := "."
			if len(args) == 1 {
				target = args[0]
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			modules, err := projectvalidator.ListModuleInfos(resolved)
			if err != nil {
				return err
			}
			printModuleList(cmd, resolved, modules, format)
			return nil
		},
	}
	cmd.Flags().StringVar(&format, "format", "pretty", "output format")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "tsv")))
	return cmd
}

func newModuleShowCommand() *cobra.Command {
	format := "pretty"
	cmd := &cobra.Command{
		Use:               "show <module> [directory]",
		Short:             "Show details for a project template module",
		Args:              cobra.RangeArgs(1, 2),
		ValidArgsFunction: moduleInstallCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			if format != "pretty" && format != "tsv" {
				return fmt.Errorf("unknown format %q; use pretty or tsv", format)
			}
			target := "."
			if len(args) == 2 {
				target = args[1]
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			modules, err := projectvalidator.ListModuleInfos(resolved)
			if err != nil {
				return err
			}
			for _, module := range modules {
				if module.Name == args[0] {
					printModuleShow(cmd, resolved, module, format)
					return nil
				}
			}
			return fmt.Errorf("unknown module %q", args[0])
		},
	}
	cmd.Flags().StringVar(&format, "format", "pretty", "output format")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "tsv")))
	return cmd
}

func newModuleAddCommand() *cobra.Command {
	dryRun := false
	force := false
	format := "pretty"
	yes := false
	legacyApply := false
	cmd := &cobra.Command{
		Use:               "add <module> [directory]",
		Aliases:           []string{"install"},
		Short:             "Add a project template module",
		Args:              cobra.RangeArgs(1, 2),
		ValidArgsFunction: moduleInstallCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			target := "."
			if len(args) == 2 {
				target = args[1]
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			if legacyApply {
				yes = true
			}
			if yes && dryRun {
				return fmt.Errorf("--yes and --dry-run cannot be used together")
			}
			if format != "pretty" && format != "tsv" {
				return fmt.Errorf("unknown format %q; use pretty or tsv", format)
			}
			if format == "tsv" && !dryRun && !yes {
				return fmt.Errorf("use --dry-run or --yes with --format tsv")
			}

			plan, err := projectvalidator.InstallModule(resolved, args[0], projectvalidator.ModuleInstallOptions{Force: force})
			if err != nil {
				return err
			}
			displayOptions := projectvalidator.ModuleInstallOptions{Apply: yes, DryRun: dryRun, Force: force}
			printModuleInstallPlan(cmd, plan, displayOptions, format)
			if dryRun || len(plan.ToInstall) == 0 {
				return nil
			}
			if !yes {
				confirmed, err := confirmApply(cmd)
				if err != nil {
					return err
				}
				if !confirmed {
					printModuleCanceled(cmd, format)
					return nil
				}
			}
			applied, err := projectvalidator.InstallModule(resolved, args[0], projectvalidator.ModuleInstallOptions{Apply: true, Force: force})
			if err != nil {
				return err
			}
			printModuleApplied(cmd, applied.LockPath, format)
			return nil
		},
	}
	cmd.Flags().BoolVar(&legacyApply, "apply", false, "write the module add plan without prompting")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "show the module add plan without writing changes")
	cmd.Flags().BoolVar(&force, "force", false, "allow module add to overwrite existing project files")
	cmd.Flags().StringVar(&format, "format", "pretty", "output format")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "apply the module add plan without prompting")
	must(cmd.Flags().MarkHidden("apply"))
	must(cmd.Flags().MarkDeprecated("apply", "use --yes instead"))
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "tsv")))
	return cmd
}

func newModuleRemoveCommand() *cobra.Command {
	dryRun := false
	format := "pretty"
	yes := false
	cmd := &cobra.Command{
		Use:               "remove <module> [directory]",
		Short:             "Remove a project template module",
		Args:              cobra.RangeArgs(1, 2),
		ValidArgsFunction: moduleInstallCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			target := "."
			if len(args) == 2 {
				target = args[1]
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			if yes && dryRun {
				return fmt.Errorf("--yes and --dry-run cannot be used together")
			}
			if format != "pretty" && format != "tsv" {
				return fmt.Errorf("unknown format %q; use pretty or tsv", format)
			}
			if format == "tsv" && !dryRun && !yes {
				return fmt.Errorf("use --dry-run or --yes with --format tsv")
			}

			plan, err := projectvalidator.RemoveModule(resolved, args[0], projectvalidator.ModuleRemoveOptions{})
			if err != nil {
				return err
			}
			displayOptions := projectvalidator.ModuleRemoveOptions{Apply: yes, DryRun: dryRun}
			printModuleRemovePlan(cmd, plan, displayOptions, format)
			if dryRun || len(plan.ToRemove) == 0 {
				return nil
			}
			if !yes {
				confirmed, err := confirmApply(cmd)
				if err != nil {
					return err
				}
				if !confirmed {
					printModuleCanceled(cmd, format)
					return nil
				}
			}
			applied, err := projectvalidator.RemoveModule(resolved, args[0], projectvalidator.ModuleRemoveOptions{Apply: true})
			if err != nil {
				return err
			}
			printModuleApplied(cmd, applied.LockPath, format)
			return nil
		},
	}
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "show the module remove plan without writing changes")
	cmd.Flags().StringVar(&format, "format", "pretty", "output format")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "apply the module remove plan without prompting")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "tsv")))
	return cmd
}

func moduleInstallCompletion(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	if len(args) == 0 {
		modules, err := projectvalidator.ListModules(".")
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		matches := []string{}
		for _, module := range modules {
			if strings.HasPrefix(module, toComplete) {
				matches = append(matches, module)
			}
		}
		return matches, cobra.ShellCompDirectiveNoFileComp
	}
	if len(args) == 1 {
		return nil, cobra.ShellCompDirectiveFilterDirs
	}
	return nil, cobra.ShellCompDirectiveNoFileComp
}

func printModuleInstallPlan(cmd *cobra.Command, plan projectvalidator.ModuleInstallPlan, options projectvalidator.ModuleInstallOptions, format string) {
	if format == "tsv" {
		printModuleInstallPlanTSV(cmd, plan, options)
		return
	}

	mode := "DRY-RUN"
	if options.Apply {
		mode = "APPLY"
	} else if !options.DryRun {
		mode = "CONFIRM"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Module add plan\n")
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", plan.ProjectRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Mode: %s\n\n", strings.ToLower(mode))

	fmt.Fprintln(cmd.OutOrStdout(), "Modules")
	for _, module := range plan.AlreadyInstalled {
		fmt.Fprintf(cmd.OutOrStdout(), "  = %s already installed\n", module)
	}
	for _, module := range plan.ToInstall {
		fmt.Fprintf(cmd.OutOrStdout(), "  + %s\n", module)
	}
	if len(plan.AlreadyInstalled) == 0 && len(plan.ToInstall) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "  no module changes")
	}

	fmt.Fprintln(cmd.OutOrStdout(), "\nFiles")
	for _, file := range plan.Files {
		fmt.Fprintf(cmd.OutOrStdout(), "  %s %-40s %s\n", moduleFileActionSymbol(file.Action), file.Path, file.Module)
	}
	if len(plan.Files) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "  no file changes")
	}

	if len(plan.ToInstall) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "\nResult: no module changes")
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

func printModuleInstallPlanTSV(cmd *cobra.Command, plan projectvalidator.ModuleInstallPlan, options projectvalidator.ModuleInstallOptions) {
	mode := "dry_run"
	if options.Apply {
		mode = "apply"
	} else if !options.DryRun {
		mode = "confirm"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "PLAN\tmodule_add\t%s\t%s\n", mode, plan.ProjectRoot)
	for _, module := range plan.AlreadyInstalled {
		fmt.Fprintf(cmd.OutOrStdout(), "KEEP\tmodule\t%s\t.\n", module)
	}
	for _, module := range plan.ToInstall {
		fmt.Fprintf(cmd.OutOrStdout(), "ADD\tmodule\t%s\t.\n", module)
	}
	for _, file := range plan.Files {
		fmt.Fprintf(cmd.OutOrStdout(), "%s\tfile\t%s\t%s\n", file.Action, file.Path, file.Module)
	}
	if len(plan.ToInstall) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tok\t.\tno module changes")
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
}

func printModuleRemovePlan(cmd *cobra.Command, plan projectvalidator.ModuleRemovePlan, options projectvalidator.ModuleRemoveOptions, format string) {
	if format == "tsv" {
		printModuleRemovePlanTSV(cmd, plan, options)
		return
	}

	mode := "DRY-RUN"
	if options.Apply {
		mode = "APPLY"
	} else if !options.DryRun {
		mode = "CONFIRM"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Module remove plan\n")
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", plan.ProjectRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Mode: %s\n\n", strings.ToLower(mode))

	fmt.Fprintln(cmd.OutOrStdout(), "Modules")
	for _, module := range plan.ToRemove {
		fmt.Fprintf(cmd.OutOrStdout(), "  - %s\n", module)
	}
	if len(plan.ToRemove) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "  no module changes")
	}

	fmt.Fprintln(cmd.OutOrStdout(), "\nFiles")
	for _, file := range plan.Files {
		fmt.Fprintf(cmd.OutOrStdout(), "  %s %-40s %s\n", moduleFileActionSymbol(file.Action), file.Path, file.Module)
	}
	if len(plan.Files) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "  no file changes")
	}

	if len(plan.ToRemove) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "\nResult: no module changes")
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

func printModuleRemovePlanTSV(cmd *cobra.Command, plan projectvalidator.ModuleRemovePlan, options projectvalidator.ModuleRemoveOptions) {
	mode := "dry_run"
	if options.Apply {
		mode = "apply"
	} else if !options.DryRun {
		mode = "confirm"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "PLAN\tmodule_remove\t%s\t%s\n", mode, plan.ProjectRoot)
	for _, module := range plan.ToRemove {
		fmt.Fprintf(cmd.OutOrStdout(), "DELETE\tmodule\t%s\t.\n", module)
	}
	for _, file := range plan.Files {
		fmt.Fprintf(cmd.OutOrStdout(), "%s\tfile\t%s\t%s\n", file.Action, file.Path, file.Module)
	}
	if len(plan.ToRemove) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tok\t.\tno module changes")
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
}

func printModuleApplied(cmd *cobra.Command, lockPath string, format string) {
	if format == "tsv" {
		fmt.Fprintf(cmd.OutOrStdout(), "RESULT\tapplied\t%s\tlock updated\n", lockPath)
		return
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Result: applied\nLock: %s\n", lockPath)
}

func printModuleCanceled(cmd *cobra.Command, format string) {
	if format == "tsv" {
		fmt.Fprintln(cmd.OutOrStdout(), "RESULT\tcanceled\t.\tno changes written")
		return
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Result: canceled, no changes written")
}

func moduleFileActionSymbol(action string) string {
	switch action {
	case "ADD":
		return "+"
	case "OVERWRITE":
		return "!"
	case "DELETE":
		return "-"
	default:
		return strings.ToLower(action)
	}
}

func confirmApply(cmd *cobra.Command) (bool, error) {
	fmt.Fprint(cmd.OutOrStdout(), "Apply changes? Y/n: ")
	scanner := bufio.NewScanner(cmd.InOrStdin())
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return false, err
		}
		return false, fmt.Errorf("confirmation required; rerun with --yes or --dry-run")
	}
	answer := strings.ToLower(strings.TrimSpace(scanner.Text()))
	return answer == "" || answer == "y" || answer == "yes", nil
}

func printModuleShow(cmd *cobra.Command, projectRoot string, module projectvalidator.ModuleInfo, format string) {
	if format == "tsv" {
		fmt.Fprintln(cmd.OutOrStdout(), "field\tvalue")
		fmt.Fprintf(cmd.OutOrStdout(), "project\t%s\n", projectRoot)
		fmt.Fprintf(cmd.OutOrStdout(), "status\t%s\n", moduleStatus(module))
		fmt.Fprintf(cmd.OutOrStdout(), "module\t%s\n", module.Name)
		fmt.Fprintf(cmd.OutOrStdout(), "description\t%s\n", module.Description)
		fmt.Fprintf(cmd.OutOrStdout(), "default\t%t\n", module.Default)
		fmt.Fprintf(cmd.OutOrStdout(), "depends_on\t%s\n", joinList(module.DependsOn))
		fmt.Fprintf(cmd.OutOrStdout(), "values\t%s\n", joinList(moduleValueNames(module.Values)))
		fmt.Fprintf(cmd.OutOrStdout(), "owns\t%s\n", joinList(module.Owns))
		fmt.Fprintf(cmd.OutOrStdout(), "files\t%s\n", joinList(module.Files))
		return
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Module: %s\n", module.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", projectRoot)
	fmt.Fprintf(cmd.OutOrStdout(), "Status: %s\n", moduleStatus(module))
	fmt.Fprintf(cmd.OutOrStdout(), "Description: %s\n", prettyValue(module.Description))
	fmt.Fprintf(cmd.OutOrStdout(), "Default: %t\n", module.Default)
	fmt.Fprintf(cmd.OutOrStdout(), "Depends on: %s\n", prettyList(module.DependsOn))
	fmt.Fprintf(cmd.OutOrStdout(), "Values: %s\n", prettyList(moduleValueNames(module.Values)))
	fmt.Fprintf(cmd.OutOrStdout(), "Owns: %s\n", prettyList(module.Owns))
	fmt.Fprintf(cmd.OutOrStdout(), "Files: %s\n", prettyList(module.Files))
}

func moduleValueNames(values map[string]projectvalidator.TemplateValueSpec) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func printModuleList(cmd *cobra.Command, projectRoot string, modules []projectvalidator.ModuleInfo, format string) {
	if format == "tsv" {
		fmt.Fprintln(cmd.OutOrStdout(), "status\tmodule\tdescription\tdefault\tdepends_on\towns\tfiles")
		for _, module := range modules {
			fmt.Fprintf(
				cmd.OutOrStdout(),
				"%s\t%s\t%s\t%t\t%s\t%s\t%s\n",
				moduleStatus(module),
				module.Name,
				module.Description,
				module.Default,
				joinList(module.DependsOn),
				joinList(module.Owns),
				joinList(module.Files),
			)
		}
		return
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Modules for %s\n", projectRoot)
	for _, module := range modules {
		fmt.Fprintf(cmd.OutOrStdout(), "\n%s %s\n", strings.ToUpper(moduleStatus(module)), module.Name)
		fmt.Fprintf(cmd.OutOrStdout(), "  description: %s\n", prettyValue(module.Description))
		fmt.Fprintf(cmd.OutOrStdout(), "  default: %t\n", module.Default)
		fmt.Fprintf(cmd.OutOrStdout(), "  depends_on: %s\n", prettyList(module.DependsOn))
		fmt.Fprintf(cmd.OutOrStdout(), "  owns: %s\n", prettyList(module.Owns))
		fmt.Fprintf(cmd.OutOrStdout(), "  files: %s\n", prettyList(module.Files))
	}
}

func moduleStatus(module projectvalidator.ModuleInfo) string {
	if module.Installed {
		return "installed"
	}
	return "available"
}

func prettyList(values []string) string {
	if len(values) == 0 {
		return "-"
	}
	return strings.Join(values, ", ")
}

func prettyValue(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func joinList(values []string) string {
	return strings.Join(values, ";")
}
