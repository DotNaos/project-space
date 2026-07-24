package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/spf13/cobra"
)

type silentApprovalPresenter struct{}

func (silentApprovalPresenter) Present(context.Context, string) error { return nil }

func newMachineStatusCommand() *cobra.Command {
	return newMachineStatusCommandWithDependencyFactory(defaultMachineConnectionDependencies)
}

func newMachineStatusCommandWithDependencies(dependencies machineConnectionCommandDependencies) *cobra.Command {
	return newMachineStatusCommandWithDependencyFactory(fixedMachineConnectionDependencies(dependencies))
}

func newMachineStatusCommandWithDependencyFactory(
	loadDependencies machineConnectionCommandDependencyFactory,
) *cobra.Command {
	jsonOutput := false
	command := &cobra.Command{
		Use:   "status",
		Short: "Show this machine's Project Space connection",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			dependencies, err := loadDependencies()
			if err != nil {
				return err
			}
			workflow, err := machineConnectionWorkflow(dependencies, silentApprovalPresenter{})
			if err != nil {
				return err
			}
			status, err := workflow.Status(command.Context())
			if err != nil {
				return err
			}
			if jsonOutput {
				return writeMachineConnectionJSON(command.OutOrStdout(), map[string]any{
					"configured":  status.Configured,
					"machineId":   status.MachineID,
					"machineName": status.MachineName,
					"status":      status.State,
				})
			}
			if !status.Configured {
				fmt.Fprintln(command.OutOrStdout(), "This machine is not connected to Project Space.")
				return nil
			}
			fmt.Fprintf(command.OutOrStdout(), "Machine %s is %s.\n", status.MachineName, status.State)
			return nil
		},
	}
	command.Flags().BoolVar(&jsonOutput, "json", false, "print machine-readable output")
	return command
}

func newMachineDoctorCommand() *cobra.Command {
	return newMachineDoctorCommandWithDependencyFactory(defaultMachineConnectionDependencies)
}

func newMachineDoctorCommandWithDependencies(dependencies machineConnectionCommandDependencies) *cobra.Command {
	return newMachineDoctorCommandWithDependencyFactory(fixedMachineConnectionDependencies(dependencies))
}

func newMachineDoctorCommandWithDependencyFactory(
	loadDependencies machineConnectionCommandDependencyFactory,
) *cobra.Command {
	return newMachineDoctorCommandWithDependencyFactoryAndDirectoryDoctor(
		loadDependencies,
		newProjectDirectoryDoctor(os.UserHomeDir),
	)
}

type machineDoctorCommandResult struct {
	machineconnect.DoctorResult
	ProjectDirectories projectDirectoryReport `json:"projectDirectories"`
}

func newMachineDoctorCommandWithDependencyFactoryAndDirectoryDoctor(
	loadDependencies machineConnectionCommandDependencyFactory,
	directoryDoctor projectDirectoryDoctor,
) *cobra.Command {
	return newMachineDoctorCommandWithAllDependencies(
		loadDependencies,
		directoryDoctor,
		defaultMachineReadinessCommandDependencies(),
	)
}

func newMachineDoctorCommandWithAllDependencies(
	loadDependencies machineConnectionCommandDependencyFactory,
	directoryDoctor projectDirectoryDoctor,
	readinessDependencies machineReadinessCommandDependencies,
) *cobra.Command {
	jsonOutput := false
	fix := false
	yes := false
	format := "text"
	target := machineReadinessTargetOptions{}
	command := &cobra.Command{
		Use:   "doctor",
		Short: "Diagnose local or managed-machine Project Space readiness",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			outputFormat, err := doctorOutputFormat(format, jsonOutput)
			if err != nil {
				return err
			}
			if yes && !fix {
				return errors.New("--yes requires --fix")
			}
			if target.remote() {
				return runRemoteMachineDoctor(
					command, target, fix, yes, outputFormat, readinessDependencies,
				)
			}
			if target.connectorID != "" {
				return errors.New("--connector requires --machine or --machine-id")
			}
			directories, err := directoryDoctor.Check(false)
			if err != nil {
				return err
			}
			if fix && directories.hasMissing() {
				confirmed := yes
				if !confirmed {
					confirmed, err = confirmProjectDirectoryFix(
						command.InOrStdin(),
						command.ErrOrStderr(),
					)
					if err != nil {
						return err
					}
				}
				if !confirmed {
					if outputFormat == "json" {
						_ = writeMachineConnectionJSON(command.OutOrStdout(), machineDoctorCommandResult{
							ProjectDirectories: directories,
						})
					} else {
						writeProjectDirectoryReport(command.OutOrStdout(), directories)
					}
					return errors.New("repair was not confirmed; no changes were made")
				}
				directories, err = directoryDoctor.Check(true)
				if err != nil {
					return err
				}
			}
			dependencies, err := loadDependencies()
			if err != nil {
				return err
			}
			workflow, err := machineConnectionWorkflow(dependencies, silentApprovalPresenter{})
			if err != nil {
				return err
			}
			result, err := workflow.Doctor(command.Context())
			if err != nil {
				return err
			}
			commandResult := machineDoctorCommandResult{
				DoctorResult:       result,
				ProjectDirectories: directories,
			}
			if outputFormat == "json" {
				if err := writeMachineConnectionJSON(command.OutOrStdout(), commandResult); err != nil {
					return err
				}
			} else {
				writeProjectDirectoryReport(command.OutOrStdout(), directories)
				fmt.Fprintln(command.OutOrStdout(), "Project Space backend is reachable.")
				if !result.CredentialFound {
					fmt.Fprintln(command.OutOrStdout(), "This machine has not been connected yet.")
				} else {
					fmt.Fprintf(command.OutOrStdout(), "Machine credential is valid; connector is %s.\n", result.State)
				}
			}
			if directories.hasMissing() {
				return errors.New(`required project directories are missing; run "project doctor --fix"`)
			}
			return nil
		},
	}
	command.Flags().BoolVar(&jsonOutput, "json", false, "print machine-readable output")
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	command.Flags().BoolVar(&fix, "fix", false, "apply the exact confirmed managed repair plan")
	command.Flags().BoolVar(&yes, "yes", false, "confirm the current exact repair plan non-interactively")
	command.Flags().StringVar(&target.machineName, "machine", "", "exact physical machine name")
	command.Flags().StringVar(&target.machineID, "machine-id", "", "exact physical machine ID")
	command.Flags().StringVar(&target.connectorID, "connector", "", "exact connector installation ID")
	return command
}

func newDisconnectCommand() *cobra.Command {
	return newDisconnectCommandWithDependencyFactory(defaultMachineConnectionDependencies)
}

func newDisconnectCommandWithDependencies(dependencies machineConnectionCommandDependencies) *cobra.Command {
	return newDisconnectCommandWithDependencyFactory(fixedMachineConnectionDependencies(dependencies))
}

func newDisconnectCommandWithDependencyFactory(
	loadDependencies machineConnectionCommandDependencyFactory,
) *cobra.Command {
	jsonOutput := false
	command := &cobra.Command{
		Use:   "disconnect",
		Short: "Disconnect this machine from Project Space",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			dependencies, err := loadDependencies()
			if err != nil {
				return err
			}
			ctx, stopSignals := commandTerminationContext(command.Context())
			defer stopSignals()
			workflow, err := machineConnectionWorkflow(dependencies, silentApprovalPresenter{})
			if err != nil {
				return err
			}
			if err := workflow.Disconnect(ctx); err != nil {
				return err
			}
			if jsonOutput {
				return writeMachineConnectionJSON(command.OutOrStdout(), map[string]string{"status": "disconnected"})
			}
			fmt.Fprintln(command.OutOrStdout(), "This machine is disconnected from Project Space.")
			return nil
		},
	}
	command.Flags().BoolVar(&jsonOutput, "json", false, "print machine-readable output")
	return command
}

var _ machineconnect.ApprovalPresenter = silentApprovalPresenter{}
