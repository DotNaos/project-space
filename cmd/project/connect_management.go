package main

import (
	"context"
	"fmt"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/spf13/cobra"
)

type silentApprovalPresenter struct{}

func (silentApprovalPresenter) Present(context.Context, string) error { return nil }

func newMachineStatusCommand() *cobra.Command {
	return newMachineStatusCommandWithDependencies(defaultMachineConnectionDependencies())
}

func newMachineStatusCommandWithDependencies(dependencies machineConnectionCommandDependencies) *cobra.Command {
	jsonOutput := false
	command := &cobra.Command{
		Use:   "status",
		Short: "Show this machine's Project Space connection",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
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
	return newMachineDoctorCommandWithDependencies(defaultMachineConnectionDependencies())
}

func newMachineDoctorCommandWithDependencies(dependencies machineConnectionCommandDependencies) *cobra.Command {
	jsonOutput := false
	command := &cobra.Command{
		Use:   "doctor",
		Short: "Check this machine's Project Space connection",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			workflow, err := machineConnectionWorkflow(dependencies, silentApprovalPresenter{})
			if err != nil {
				return err
			}
			result, err := workflow.Doctor(command.Context())
			if err != nil {
				return err
			}
			if jsonOutput {
				return writeMachineConnectionJSON(command.OutOrStdout(), result)
			}
			fmt.Fprintln(command.OutOrStdout(), "Project Space backend is reachable.")
			if !result.CredentialFound {
				fmt.Fprintln(command.OutOrStdout(), "This machine has not been connected yet.")
				return nil
			}
			fmt.Fprintf(command.OutOrStdout(), "Machine credential is valid; connector is %s.\n", result.State)
			return nil
		},
	}
	command.Flags().BoolVar(&jsonOutput, "json", false, "print machine-readable output")
	return command
}

func newDisconnectCommand() *cobra.Command {
	return newDisconnectCommandWithDependencies(defaultMachineConnectionDependencies())
}

func newDisconnectCommandWithDependencies(dependencies machineConnectionCommandDependencies) *cobra.Command {
	jsonOutput := false
	command := &cobra.Command{
		Use:   "disconnect",
		Short: "Disconnect this machine from Project Space",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			workflow, err := machineConnectionWorkflow(dependencies, silentApprovalPresenter{})
			if err != nil {
				return err
			}
			if err := workflow.Disconnect(command.Context()); err != nil {
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
