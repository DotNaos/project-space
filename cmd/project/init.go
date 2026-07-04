package main

import (
	"fmt"
	"path/filepath"

	"github.com/DotNaos/project-space/internal/projectvalidator"
	"github.com/spf13/cobra"
)

func newInitCommand() *cobra.Command {
	options := projectvalidator.InitOptions{}
	cmd := &cobra.Command{
		Use:               "init [directory]",
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
