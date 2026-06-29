package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/DotNaos/project-space/internal/projectvalidator"
	"github.com/spf13/cobra"
)

func main() {
	root := newRootCommand()
	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "VIOLATION", err)
		os.Exit(1)
	}
}

func newRootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:           "project",
		Short:         "Template-aware Project CLI",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(newCreateCommand())
	root.AddCommand(newInitCommand())
	root.AddCommand(newModuleCommand())
	root.AddCommand(newTemplateCommand())
	root.AddCommand(newValidateCommand())
	return root
}

func newCreateCommand() *cobra.Command {
	options := projectvalidator.InitOptions{}
	localTmp := false
	globalTmp := false
	github := false
	secrets := false
	cmd := &cobra.Command{
		Use:               "create [project-directory]",
		Aliases:           []string{"new"},
		Short:             "Create and initialize a new project",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			if secrets && !github {
				return fmt.Errorf("--secrets requires --github")
			}
			if localTmp && globalTmp {
				return fmt.Errorf("--local-tmp and --global-tmp cannot be used together")
			}
			useTmp := localTmp || globalTmp
			if !useTmp && len(args) == 0 {
				return fmt.Errorf("project directory is required unless --tmp, --local-tmp, or --global-tmp is used")
			}
			target := ""
			if len(args) == 1 {
				target = args[0]
			}
			if useTmp {
				var err error
				target, err = tmpProjectTarget(target, globalTmp)
				if err != nil {
					return err
				}
				if err := os.RemoveAll(target); err != nil {
					return err
				}
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			lockPath, err := projectvalidator.CreateProject(resolved, options)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Created project: %s\n", resolved)
			fmt.Fprintf(cmd.OutOrStdout(), "Initialized project template lock: %s\n", lockPath)
			if useTmp {
				valuesPath, err := projectvalidator.WriteTmpTemplateValues(resolved)
				if err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "Wrote tmp template values: %s\n", valuesPath)
				plans, err := projectvalidator.InstallDefaultModules(resolved)
				if err != nil {
					return err
				}
				for _, plan := range plans {
					fmt.Fprintf(cmd.OutOrStdout(), "Installed module: %s\n", plan.Module)
				}
			}
			if github {
				result, err := createGitHubRepository(resolved, createGitHubRepositoryOptions{Secrets: secrets})
				if err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "GitHub repository: %s\n", result.URL)
				if result.SecretSet {
					fmt.Fprintln(cmd.OutOrStdout(), "GitHub secret: OP_SERVICE_ACCOUNT_TOKEN set")
				}
				fmt.Fprintln(cmd.OutOrStdout(), "Pushed initial commit: main")
			}
			fmt.Fprintf(cmd.OutOrStdout(), "cd %s\n", shellQuote(resolved))
			return nil
		},
	}
	addInitFlags(cmd, &options)
	cmd.Flags().BoolVar(&github, "github", false, "create a private GitHub repository and push the project")
	cmd.Flags().BoolVar(&secrets, "secrets", false, "set required GitHub secrets; requires --github")
	cmd.Flags().BoolVar(&localTmp, "tmp", false, "create a local tmp project in ./tmp and install default modules")
	cmd.Flags().BoolVar(&localTmp, "local-tmp", false, "create a local tmp project in ./tmp and install default modules")
	cmd.Flags().BoolVar(&globalTmp, "global-tmp", false, "create a global tmp project in /tmp and install default modules")
	return cmd
}

func tmpProjectTarget(name string, global bool) (string, error) {
	suffix, err := randomSuffix()
	if err != nil {
		return "", err
	}
	if name == "" {
		name = "generated-app"
	}
	base := filepath.Base(filepath.Clean(name))
	if base == "." || base == string(filepath.Separator) {
		base = "generated-app"
	}
	base = base + "-" + suffix
	if global {
		return filepath.Join("/tmp", "project-"+base), nil
	}
	return filepath.Join("tmp", base), nil
}

func randomSuffix() (string, error) {
	bytes := make([]byte, 4)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate tmp project suffix: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	if !strings.ContainsAny(value, " \t\n'\"\\$&;()[]{}!*?<>|`") {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func newInitCommand() *cobra.Command {
	options := projectvalidator.InitOptions{}
	cmd := &cobra.Command{
		Use:               "init [project-directory]",
		Short:             "Initialize a project template lock",
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
			lockPath, err := projectvalidator.InitProject(resolved, options)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Initialized project template lock: %s\n", lockPath)
			return nil
		},
	}
	addInitFlags(cmd, &options)
	return cmd
}

func addInitFlags(cmd *cobra.Command, options *projectvalidator.InitOptions) {
	cmd.Flags().StringVar(&options.Template, "template", "", "template repository")
	cmd.Flags().StringVar(&options.TemplatePath, "template-path", "", "template path")
	cmd.Flags().StringVar(&options.Version, "version", "", "template version")
	cmd.Flags().StringVar(&options.Commit, "commit", "", "template commit or label")
	cmd.Flags().BoolVar(&options.Force, "force", false, "replace an existing .project/template.lock.yaml")
	must(cmd.RegisterFlagCompletionFunc("template", fixedValuesCompletion("DotNaos/project-template")))
	must(cmd.RegisterFlagCompletionFunc("template-path", directoryCompletion))
}

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
		Use:               "list [project-directory]",
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
		Use:               "show <module> [project-directory]",
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
		Use:               "add <module> [project-directory]",
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
		Use:               "remove <module> [project-directory]",
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
	fmt.Fprintf(cmd.OutOrStdout(), "Owns: %s\n", prettyList(module.Owns))
	fmt.Fprintf(cmd.OutOrStdout(), "Files: %s\n", prettyList(module.Files))
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

func newTemplateCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "template",
		Short: "Manage the local project template snapshot",
	}
	cmd.AddCommand(newTemplateSyncCommand())
	return cmd
}

func newTemplateSyncCommand() *cobra.Command {
	options := projectvalidator.TemplateSyncOptions{}
	format := "pretty"
	cmd := &cobra.Command{
		Use:               "sync [project-directory]",
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

func newValidateCommand() *cobra.Command {
	options := projectvalidator.DefaultOutputOptions()
	quarantine := false
	dryRun := false
	yes := false
	cmd := &cobra.Command{
		Use:               "validate [project-directory|file]",
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

func fixedValuesCompletion(values ...string) func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		return values, cobra.ShellCompDirectiveNoFileComp
	}
}

func directoryCompletion(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	return nil, cobra.ShellCompDirectiveFilterDirs
}

func fileCompletion(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
	return nil, cobra.ShellCompDirectiveDefault
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	return wd
}
