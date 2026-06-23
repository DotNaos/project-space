package main

import (
	"fmt"
	"os"
	"path/filepath"

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
	root.AddCommand(newInitCommand())
	root.AddCommand(newValidateCommand())
	return root
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
	cmd.Flags().StringVar(&options.Template, "template", "", "template repository")
	cmd.Flags().StringVar(&options.TemplatePath, "template-path", "", "template path")
	cmd.Flags().StringVar(&options.Version, "version", "", "template version")
	cmd.Flags().StringVar(&options.Commit, "commit", "", "template commit or label")
	cmd.Flags().BoolVar(&options.Force, "force", false, "replace an existing .project/template.lock.json")
	must(cmd.RegisterFlagCompletionFunc("template", fixedValuesCompletion("DotNaos/project-template")))
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
