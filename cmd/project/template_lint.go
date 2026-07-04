package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/DotNaos/project-space/internal/projectvalidator"
	"github.com/spf13/cobra"
)

func newTemplateLintCommand() *cobra.Command {
	templatePath := ""
	format := "pretty"
	cmd := &cobra.Command{
		Use:   "lint",
		Short: "Validate a template checkout",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return fmt.Errorf("unexpected arguments: %v", args)
			}
			if format != "pretty" && format != "json" {
				return fmt.Errorf("unknown format %q; use pretty or json", format)
			}
			root, err := resolveTemplateLintRoot(templatePath)
			if err != nil {
				return err
			}
			report, err := projectvalidator.LintTemplate(root)
			if err != nil {
				return err
			}
			if err := printTemplateLintReport(cmd, report, format); err != nil {
				return err
			}
			if !report.OK {
				return fmt.Errorf("template lint failed")
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&templatePath, "template-path", "", "template checkout path")
	cmd.Flags().StringVar(&format, "format", "pretty", "output format")
	must(cmd.RegisterFlagCompletionFunc("template-path", directoryCompletion))
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "json")))
	return cmd
}

func resolveTemplateLintRoot(templatePath string) (string, error) {
	root := templatePath
	if root == "" {
		root = "."
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	return abs, nil
}

func printTemplateLintReport(cmd *cobra.Command, report projectvalidator.TemplateLintReport, format string) error {
	if format == "json" {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	}

	fmt.Fprintln(cmd.OutOrStdout(), "Template lint")
	fmt.Fprintf(cmd.OutOrStdout(), "Template: %s@%s\n", prettyDash(report.Template), prettyDash(report.Version))
	fmt.Fprintf(cmd.OutOrStdout(), "Root: %s\n", report.TemplateRoot)
	if len(report.Findings) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "\nFindings: none")
		fmt.Fprintln(cmd.OutOrStdout(), "\nResult: ok")
		return nil
	}
	fmt.Fprintln(cmd.OutOrStdout(), "\nFindings")
	for _, finding := range report.Findings {
		path := finding.Path
		if path == "" {
			path = "-"
		}
		fmt.Fprintf(cmd.OutOrStdout(), "  %-7s %-24s %-40s %s\n", finding.Severity, finding.Code, path, finding.Message)
	}
	if report.OK {
		fmt.Fprintln(cmd.OutOrStdout(), "\nResult: ok with warnings")
		return nil
	}
	fmt.Fprintln(cmd.OutOrStdout(), "\nResult: failed")
	return nil
}
