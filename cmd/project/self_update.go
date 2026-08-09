package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/DotNaos/project-space/internal/selfupdate"
	"github.com/spf13/cobra"
)

type selfUpdateService interface {
	Plan(context.Context, selfupdate.PlanOptions) (selfupdate.Plan, error)
	Apply(
		context.Context,
		selfupdate.Plan,
		io.Writer,
		io.Writer,
	) (selfupdate.Result, error)
}

type selfUpdateOptions struct {
	Check          bool
	Format         string
	MigrateManaged bool
	Yes            bool
}

func newSelfUpdateCommand() *cobra.Command {
	return newSelfUpdateCommandWithServiceFactory(defaultSelfUpdateService)
}

func defaultSelfUpdateService() (selfUpdateService, error) {
	return selfupdate.NewService(
		selfupdate.NewDefaultInstallDetector(projectMachineClientVersion),
		selfupdate.NewGitHubReleaseResolver(selfupdate.GitHubReleaseResolverOptions{}),
		selfupdate.NewManagedArtifactInstaller(selfupdate.ArtifactInstallerOptions{}),
	)
}

func newSelfUpdateCommandWithService(service selfUpdateService) *cobra.Command {
	return newSelfUpdateCommandWithServiceFactory(func() (selfUpdateService, error) {
		if service == nil {
			return nil, errors.New("self-update service is unavailable")
		}
		return service, nil
	})
}

func newSelfUpdateCommandWithServiceFactory(
	loadService func() (selfUpdateService, error),
) *cobra.Command {
	options := selfUpdateOptions{Format: "pretty"}
	command := &cobra.Command{
		Use:   "self-update",
		Short: "Check for and install a signed Project CLI and connector release",
		Args:  cobra.NoArgs,
		PreRunE: func(_ *cobra.Command, _ []string) error {
			if options.Check && options.Yes {
				return errors.New("--check and --yes cannot be used together")
			}
			if options.Format != "pretty" && options.Format != "json" {
				return errors.New(`--format must be "pretty" or "json"`)
			}
			return nil
		},
		RunE: func(command *cobra.Command, _ []string) error {
			service, err := loadService()
			if err != nil {
				return err
			}
			plan, planErr := service.Plan(command.Context(), selfupdate.PlanOptions{
				MigrateManaged: options.MigrateManaged,
			})
			if planErr != nil {
				if err := writeSelfUpdateResult(command.OutOrStdout(), options.Format, plan.Result); err != nil {
					return errors.Join(planErr, err)
				}
				return planErr
			}
			if plan.Result.State != selfupdate.StateUpdateAvailable {
				if err := writeSelfUpdateResult(command.OutOrStdout(), options.Format, plan.Result); err != nil {
					return err
				}
				if plan.Result.State == selfupdate.StateUnsupportedSource {
					return errors.New(plan.Result.ActionableBlocker)
				}
				return nil
			}

			jsonOutput := options.Format == "json"
			if options.Check || (jsonOutput && !options.Yes) {
				return writeSelfUpdateResult(command.OutOrStdout(), options.Format, plan.Result)
			}
			if !options.Yes {
				if err := writeSelfUpdateResult(command.OutOrStdout(), options.Format, plan.Result); err != nil {
					return err
				}
				confirmed, err := confirmSelfUpdate(
					command.InOrStdin(),
					command.OutOrStdout(),
					plan.Result.MigrateManaged,
				)
				if err != nil {
					return err
				}
				if !confirmed {
					action := "Update"
					if plan.Result.MigrateManaged {
						action = "Migration"
					}
					fmt.Fprintf(command.OutOrStdout(), "%s cancelled; no files were changed.\n", action)
					return nil
				}
			}

			installerStdout := command.OutOrStdout()
			installerStderr := command.ErrOrStderr()
			if jsonOutput {
				installerStdout = io.Discard
				installerStderr = io.Discard
			}
			result, applyErr := service.Apply(
				command.Context(),
				plan,
				installerStdout,
				installerStderr,
			)
			if err := writeSelfUpdateResult(command.OutOrStdout(), options.Format, result); err != nil {
				return errors.Join(applyErr, err)
			}
			return applyErr
		},
	}
	command.Flags().BoolVar(&options.Check, "check", false, "check the signed approved release without changing files")
	command.Flags().StringVar(&options.Format, "format", options.Format, "output format: pretty or json")
	command.Flags().BoolVar(&options.MigrateManaged, "migrate-managed", false, "migrate a verified Homebrew-owned CLI to signed managed delivery")
	command.Flags().BoolVarP(&options.Yes, "yes", "y", false, "install the verified update without prompting")
	return command
}

func writeSelfUpdateResult(output io.Writer, format string, result selfupdate.Result) error {
	if format == "json" {
		encoder := json.NewEncoder(output)
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	}
	var buffer bytes.Buffer
	fmt.Fprintf(&buffer, "Install source: %s\n", result.InstallSource)
	fmt.Fprintf(&buffer, "Current version: %s\n", displaySelfUpdateValue(result.CurrentVersion))
	fmt.Fprintf(&buffer, "Approved target: %s\n", displaySelfUpdateValue(result.TargetVersion))
	if result.MigrateManaged {
		fmt.Fprintf(&buffer, "Managed location: %s\n", displaySelfUpdateValue(result.ManagedInstallDir))
		fmt.Fprintf(&buffer, "Service transition: %s\n", result.ServiceTransition)
		fmt.Fprintf(&buffer, "Preserved state: %s\n", result.PreservedState)
		fmt.Fprintf(&buffer, "Rollback: %s\n", result.RollbackBehavior)
	}
	fmt.Fprintf(&buffer, "State: %s\n", result.State)
	if result.ActionableBlocker != "" {
		fmt.Fprintf(&buffer, "Action: %s\n", result.ActionableBlocker)
	}
	if result.RecoveryCommand != "" {
		fmt.Fprintf(&buffer, "Recovery command: %s\n", result.RecoveryCommand)
	}
	_, err := io.Copy(output, &buffer)
	return err
}

func displaySelfUpdateValue(value string) string {
	if strings.TrimSpace(value) == "" {
		return "unavailable"
	}
	return value
}

func confirmSelfUpdate(input io.Reader, output io.Writer, migrateManaged bool) (bool, error) {
	prompt := "Install this verified CLI and connector release now? y/N: "
	if migrateManaged {
		prompt = "Migrate from Homebrew to this verified managed CLI and connector release now? y/N: "
	}
	if _, err := fmt.Fprint(output, prompt); err != nil {
		return false, err
	}
	scanner := bufio.NewScanner(input)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return false, fmt.Errorf("read self-update confirmation: %w", err)
		}
		return false, nil
	}
	answer := strings.ToLower(strings.TrimSpace(scanner.Text()))
	return answer == "y" || answer == "yes", nil
}
