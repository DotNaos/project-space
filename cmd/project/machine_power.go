package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/machinepower"
	"github.com/spf13/cobra"
)

type machinePowerAPI interface {
	Request(context.Context, machinepower.Request) (machinepower.OperationResult, error)
	Status(context.Context, machinepower.Selector) (machinepower.StatusResult, error)
}

type machinePowerDependencies struct {
	LoadRuntime    func(context.Context) (machinePowerAPI, error)
	NewOperationID func(string) (string, error)
	PollInterval   time.Duration
	Wait           func(context.Context, time.Duration) error
}

type machinePowerTarget struct {
	id   string
	name string
}

func (target machinePowerTarget) selector() (machinepower.Selector, error) {
	if target.id != "" && target.name != "" {
		return machinepower.Selector{}, errors.New(
			"select a machine with --machine or --machine-id, not both",
		)
	}
	if target.id == "" && target.name == "" {
		return machinepower.Selector{}, errors.New("--machine or --machine-id is required")
	}
	return machinepower.Selector{
		PhysicalMachineID: target.id, PhysicalMachineName: target.name,
	}, nil
}

func defaultMachinePowerDependencies() machinePowerDependencies {
	return machinePowerDependencies{
		LoadRuntime:    loadMachinePowerRuntime,
		NewOperationID: newCodexOperationID,
		PollInterval:   2 * time.Second,
		Wait: func(ctx context.Context, duration time.Duration) error {
			timer := time.NewTimer(duration)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		},
	}
}

func loadMachinePowerRuntime(_ context.Context) (machinePowerAPI, error) {
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		return nil, errors.New("load Project machine connection")
	}
	credential, err := store.Load()
	if err != nil {
		return nil, errors.New("this machine is not connected to Project Space")
	}
	token := credential.Token
	return machinepower.NewClient(machinepower.Config{
		BaseURL:         credential.BackendURL,
		CallerMachineID: credential.MachineID,
		CredentialProvider: machinepower.CredentialProviderFunc(
			func(context.Context) (string, error) { return token, nil },
		),
	})
}

func newMachineCommand() *cobra.Command {
	command := &cobra.Command{
		Use:   "machine",
		Short: "Manage exact physical machines",
	}
	command.AddCommand(newMachinePowerCommand(defaultMachinePowerDependencies()))
	return command
}

func newMachinePowerCommand(dependencies machinePowerDependencies) *cobra.Command {
	command := &cobra.Command{
		Use:   "power",
		Short: "Inspect or request managed physical power",
	}
	command.AddCommand(newMachinePowerStatusCommand(dependencies))
	command.AddCommand(newMachinePowerActionCommand("on", dependencies))
	command.AddCommand(newMachinePowerActionCommand("off", dependencies))
	return command
}

func newMachinePowerStatusCommand(dependencies machinePowerDependencies) *cobra.Command {
	target := machinePowerTarget{}
	format := "text"
	command := &cobra.Command{
		Use:   "status",
		Short: "Show fresh managed physical-power evidence",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			selector, err := target.selector()
			if err != nil {
				return err
			}
			if format != "text" && format != "json" {
				return errors.New("--format must be text or json")
			}
			client, err := dependencies.LoadRuntime(command.Context())
			if err != nil {
				return err
			}
			result, err := client.Status(command.Context(), selector)
			if err != nil {
				return err
			}
			if err := writeMachinePowerStatus(command.OutOrStdout(), result, format); err != nil {
				return err
			}
			if result.State == "online" || result.State == "offline" {
				return nil
			}
			return &codexOutcomeError{message: result.Message}
		},
	}
	addMachinePowerTargetFlags(command, &target)
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	return command
}

func newMachinePowerActionCommand(
	action string,
	dependencies machinePowerDependencies,
) *cobra.Command {
	target := machinePowerTarget{}
	format := "text"
	noWait := false
	timeout := 60 * time.Second
	command := &cobra.Command{
		Use:   action,
		Short: fmt.Sprintf("Request the exact managed machine to power %s", action),
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			selector, err := target.selector()
			if err != nil {
				return err
			}
			if format != "text" && format != "json" {
				return errors.New("--format must be text or json")
			}
			client, err := dependencies.LoadRuntime(command.Context())
			if err != nil {
				return err
			}
			operationID, err := dependencies.NewOperationID("machine-power:" + action)
			if err != nil {
				return err
			}
			result, err := client.Request(command.Context(), machinepower.Request{
				Selector: selector, OperationID: operationID, RequestedState: action,
			})
			if err != nil {
				return err
			}
			if action == "on" &&
				(result.State == "accepted" || result.Dispatch.Attempted) && !noWait {
				result = waitForMachinePower(command.Context(), client, selector, result, timeout, dependencies)
			}
			if err := writeMachinePowerOperation(command.OutOrStdout(), result, format); err != nil {
				return err
			}
			if result.State == "accepted" || result.State == "confirmed-online" ||
				result.State == "confirmed-offline" {
				return nil
			}
			return &codexOutcomeError{message: result.Message}
		},
	}
	addMachinePowerTargetFlags(command, &target)
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	if action == "on" {
		command.Flags().BoolVar(
			&noWait, "no-wait", false, "return after the provider delivery attempt",
		)
		command.Flags().DurationVar(
			&timeout, "timeout", 60*time.Second, "maximum time to wait for physical confirmation",
		)
	}
	return command
}

func waitForMachinePower(
	ctx context.Context,
	client machinePowerAPI,
	selector machinepower.Selector,
	result machinepower.OperationResult,
	timeout time.Duration,
	dependencies machinePowerDependencies,
) machinepower.OperationResult {
	if timeout <= 0 {
		result.State = "uncertain"
		result.Message = "A wake delivery was attempted, but online state was not confirmed."
		return result
	}
	waitContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		if waitContext.Err() != nil {
			break
		}
		if dependencies.Wait(waitContext, dependencies.PollInterval) != nil {
			break
		}
		status, err := client.Status(waitContext, selector)
		if err == nil && status.State == "online" {
			result.State = "confirmed-online"
			result.Message = "JetKVM confirms that the physical machine has power."
			result.Evidence = status.Evidence
			return result
		}
	}
	result.State = "uncertain"
	result.Message = "A wake delivery was attempted, but online state was not confirmed in time."
	return result
}

func addMachinePowerTargetFlags(command *cobra.Command, target *machinePowerTarget) {
	command.Flags().StringVar(&target.name, "machine", "", "exact physical machine name")
	command.Flags().StringVar(&target.id, "machine-id", "", "exact physical machine ID")
}

func writeMachinePowerStatus(
	output io.Writer,
	result machinepower.StatusResult,
	format string,
) error {
	if format == "json" {
		return json.NewEncoder(output).Encode(result)
	}
	fmt.Fprintf(output, "Machine power: %s\n%s\n", result.State, result.Message)
	return nil
}

func writeMachinePowerOperation(
	output io.Writer,
	result machinepower.OperationResult,
	format string,
) error {
	if format == "json" {
		return json.NewEncoder(output).Encode(result)
	}
	fmt.Fprintf(
		output,
		"Machine power: %s\n%s\nOperation: %s\n",
		result.State,
		result.Message,
		result.OperationID,
	)
	return nil
}
