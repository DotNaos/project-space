package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/DotNaos/project-space/internal/projectvalidator"
	"github.com/spf13/cobra"
)

type templateSmokeOptions struct {
	Init              projectvalidator.InitOptions
	Name              string
	Container         bool
	SkipChecks        bool
	SkipSecretsDoctor bool
	GlobalTmp         bool
}

func newTemplateSmokeCommand() *cobra.Command {
	options := templateSmokeOptions{}
	cmd := &cobra.Command{
		Use:   "smoke",
		Short: "Generate a tmp project and run template smoke checks",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) > 0 {
				return fmt.Errorf("unexpected arguments: %s", strings.Join(args, " "))
			}
			return runTemplateSmoke(cmd, options)
		},
	}
	cmd.Flags().StringVar(&options.Init.Template, "template", "", "template repository")
	cmd.Flags().StringVar(&options.Init.TemplatePath, "template-path", "", "template path")
	cmd.Flags().StringVar(&options.Init.Version, "version", "", "template version")
	cmd.Flags().StringVar(&options.Init.Commit, "commit", "", "template commit or label")
	cmd.Flags().StringVar(&options.Name, "name", "generated-app", "tmp project name prefix")
	cmd.Flags().BoolVar(&options.Container, "container", false, "build generated project containers")
	cmd.Flags().BoolVar(&options.SkipChecks, "skip-checks", false, "skip dependency, secrets, check, and build commands")
	cmd.Flags().BoolVar(&options.SkipSecretsDoctor, "skip-secrets-doctor", false, "skip bun run secrets:doctor")
	cmd.Flags().BoolVar(&options.GlobalTmp, "global-tmp", false, "create the generated project under /tmp")
	must(cmd.RegisterFlagCompletionFunc("template", fixedValuesCompletion("DotNaos/project-template")))
	must(cmd.RegisterFlagCompletionFunc("template-path", directoryCompletion))
	return cmd
}

func runTemplateSmoke(cmd *cobra.Command, options templateSmokeOptions) error {
	target, err := tmpProjectTarget(options.Name, options.GlobalTmp)
	if err != nil {
		return err
	}
	resolved, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(resolved); err != nil {
		return err
	}

	lockPath, err := projectvalidator.CreateProject(resolved, options.Init)
	if err != nil {
		return err
	}
	valuesPath, err := projectvalidator.WriteTmpTemplateValues(resolved)
	if err != nil {
		return err
	}
	plans, err := projectvalidator.InstallDefaultModules(resolved)
	if err != nil {
		return err
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Generated project: %s\n", resolved)
	fmt.Fprintf(cmd.OutOrStdout(), "Template lock: %s\n", lockPath)
	fmt.Fprintf(cmd.OutOrStdout(), "Template values: %s\n", valuesPath)
	for _, plan := range plans {
		fmt.Fprintf(cmd.OutOrStdout(), "Installed module: %s\n", plan.Module)
	}

	if err := validateSmokeProject(resolved); err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), "OK validate")

	if !options.SkipChecks {
		if err := runSmokeCommand(cmd, resolved, "bun", "install", "--frozen-lockfile"); err != nil {
			return err
		}
		if !options.SkipSecretsDoctor {
			if err := runSmokeCommand(cmd, resolved, "bun", "run", "secrets:doctor"); err != nil {
				return err
			}
		}
		if err := runSmokeCommand(cmd, resolved, "bun", "run", "check"); err != nil {
			return err
		}
		if err := runSmokeCommand(cmd, resolved, "bun", "run", "build"); err != nil {
			return err
		}
	}

	if options.Container {
		if err := runSmokeCommand(cmd, resolved, "bun", "run", "container:build"); err != nil {
			return err
		}
	}

	fmt.Fprintf(cmd.OutOrStdout(), "RESULT ok %s\n", resolved)
	return nil
}

func validateSmokeProject(projectRoot string) error {
	report, err := projectvalidator.ValidateProject(projectRoot)
	if err != nil {
		return err
	}
	if !report.OK {
		return errors.New("generated project does not adhere to template")
	}
	return nil
}

func runSmokeCommand(cmd *cobra.Command, dir string, name string, args ...string) error {
	fmt.Fprintf(cmd.OutOrStdout(), "==> %s\n", strings.Join(append([]string{name}, args...), " "))
	command := exec.Command(name, args...)
	command.Dir = dir
	command.Stdout = cmd.OutOrStdout()
	command.Stderr = cmd.ErrOrStderr()
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s: %w", strings.Join(append([]string{name}, args...), " "), err)
	}
	return nil
}
