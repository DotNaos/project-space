package main

import (
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
	cmd := &cobra.Command{
		Use:               "create [project-directory]",
		Aliases:           []string{"new"},
		Short:             "Create and initialize a new project",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
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
			fmt.Fprintf(cmd.OutOrStdout(), "cd %s\n", shellQuote(resolved))
			return nil
		},
	}
	addInitFlags(cmd, &options)
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
	cmd.AddCommand(newModuleInstallCommand())
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

func newModuleInstallCommand() *cobra.Command {
	options := projectvalidator.ModuleInstallOptions{}
	cmd := &cobra.Command{
		Use:               "install <module> [project-directory]",
		Short:             "Plan or install a project template module",
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
			if options.Apply && options.DryRun {
				return fmt.Errorf("--apply and --dry-run cannot be used together")
			}
			plan, err := projectvalidator.InstallModule(resolved, args[0], options)
			if err != nil {
				return err
			}
			printModuleInstallPlan(cmd, plan, options)
			return nil
		},
	}
	cmd.Flags().BoolVar(&options.Apply, "apply", false, "write the module install plan to the project lock")
	cmd.Flags().BoolVar(&options.DryRun, "dry-run", false, "show the module install plan without writing changes")
	cmd.Flags().BoolVar(&options.Force, "force", false, "allow module install to overwrite existing project files")
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

func printModuleInstallPlan(cmd *cobra.Command, plan projectvalidator.ModuleInstallPlan, options projectvalidator.ModuleInstallOptions) {
	mode := "DRY-RUN"
	if options.Apply {
		mode = "APPLY"
	}
	fmt.Fprintf(cmd.OutOrStdout(), "%s module install plan for %s\n", mode, plan.ProjectRoot)
	for _, module := range plan.AlreadyInstalled {
		fmt.Fprintf(cmd.OutOrStdout(), "KEEP module %s\n", module)
	}
	for _, module := range plan.ToInstall {
		fmt.Fprintf(cmd.OutOrStdout(), "ADD module %s\n", module)
	}
	for _, file := range plan.Files {
		fmt.Fprintf(cmd.OutOrStdout(), "%s file %s module %s\n", file.Action, file.Path, file.Module)
	}
	if len(plan.ToInstall) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "RESULT ok no module changes")
		return
	}
	if !options.Apply {
		fmt.Fprintln(cmd.OutOrStdout(), "RESULT dry_run no changes written")
		return
	}
	fmt.Fprintf(cmd.OutOrStdout(), "RESULT applied %s\n", plan.LockPath)
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
			templatePath, checksum, err := projectvalidator.SyncTemplate(resolved, options)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Synced project template: %s\n", templatePath)
			fmt.Fprintf(cmd.OutOrStdout(), "Checksum: %s\n", checksum)
			return nil
		},
	}
	cmd.Flags().StringVar(&options.TemplatePath, "template-path", "", "template source path")
	must(cmd.RegisterFlagCompletionFunc("template-path", directoryCompletion))
	return cmd
}

func newValidateCommand() *cobra.Command {
	options := projectvalidator.DefaultOutputOptions()
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
			return validate(target, options)
		},
	}
	cmd.Flags().StringVar((*string)(&options.Format), "format", string(projectvalidator.OutputFormatPretty), "output format")
	cmd.Flags().StringVar((*string)(&options.View), "view", string(projectvalidator.ViewModeTree), "pretty output view")
	cmd.Flags().StringVar((*string)(&options.ColorScope), "color-scope", string(projectvalidator.ColorScopeLine), "color scope")
	cmd.Flags().Bool("status-color-only", false, "color only the status text")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "tsv")))
	must(cmd.RegisterFlagCompletionFunc("view", fixedValuesCompletion("tree", "table")))
	must(cmd.RegisterFlagCompletionFunc("color-scope", fixedValuesCompletion("line", "status")))
	cmd.PreRunE = func(cmd *cobra.Command, args []string) error {
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
