package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/machinereadiness"
	"github.com/spf13/cobra"
)

type machineReadinessAPI interface {
	Diagnose(context.Context, machinereadiness.Selector) (machinereadiness.Result, error)
	Fix(context.Context, machinereadiness.FixRequest) (machinereadiness.FixResult, error)
}

type machineReadinessCommandRuntime struct {
	client machineReadinessAPI
}

type machineReadinessCommandDependencies struct {
	LoadRuntime    func(context.Context) (machineReadinessCommandRuntime, error)
	NewOperationID func(string) (string, error)
	PollAttempts   int
	PollInterval   time.Duration
	Wait           func(context.Context, time.Duration) error
}

type machineReadinessTargetOptions struct {
	connectorID string
	machineID   string
	machineName string
}

func (target machineReadinessTargetOptions) remote() bool {
	return target.machineID != "" || target.machineName != ""
}

func (target machineReadinessTargetOptions) selector() (machinereadiness.Selector, error) {
	if target.machineID != "" && target.machineName != "" {
		return machinereadiness.Selector{}, errors.New(
			"select a machine with --machine or --machine-id, not both",
		)
	}
	if target.machineID == "" && target.machineName == "" {
		return machinereadiness.Selector{}, errors.New("--machine or --machine-id is required")
	}
	return machinereadiness.Selector{
		ConnectorID:         target.connectorID,
		PhysicalMachineID:   target.machineID,
		PhysicalMachineName: target.machineName,
	}, nil
}

func defaultMachineReadinessCommandDependencies() machineReadinessCommandDependencies {
	return machineReadinessCommandDependencies{
		LoadRuntime:    loadMachineReadinessCommandRuntime,
		NewOperationID: newCodexOperationID,
		PollAttempts:   120,
		PollInterval:   time.Second,
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

func loadMachineReadinessCommandRuntime(
	_ context.Context,
) (machineReadinessCommandRuntime, error) {
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		return machineReadinessCommandRuntime{}, errors.New("load Project machine connection")
	}
	credential, err := store.Load()
	if err != nil {
		return machineReadinessCommandRuntime{}, errors.New(
			"this machine is not connected to Project Space",
		)
	}
	token := credential.Token
	client, err := machinereadiness.NewClient(machinereadiness.Config{
		BaseURL:         credential.BackendURL,
		CallerMachineID: credential.MachineID,
		CredentialProvider: machinereadiness.CredentialProviderFunc(
			func(context.Context) (string, error) { return token, nil },
		),
	})
	if err != nil {
		return machineReadinessCommandRuntime{}, err
	}
	return machineReadinessCommandRuntime{client: client}, nil
}

func runRemoteMachineDoctor(
	command *cobra.Command,
	target machineReadinessTargetOptions,
	fix bool,
	yes bool,
	format string,
	dependencies machineReadinessCommandDependencies,
) error {
	selector, err := target.selector()
	if err != nil {
		return err
	}
	if dependencies.LoadRuntime == nil || dependencies.NewOperationID == nil ||
		dependencies.Wait == nil || dependencies.PollAttempts < 1 {
		return errors.New("machine readiness dependencies are incomplete")
	}
	runtime, err := dependencies.LoadRuntime(command.Context())
	if err != nil {
		return err
	}
	diagnosis, err := runtime.client.Diagnose(command.Context(), selector)
	if err != nil {
		return err
	}
	if !fix {
		if err := writeMachineReadinessResult(command.OutOrStdout(), diagnosis, format); err != nil {
			return err
		}
		return machineReadinessOutcome(diagnosis)
	}
	if diagnosis.Plan == nil {
		if err := writeMachineReadinessResult(command.OutOrStdout(), diagnosis, format); err != nil {
			return err
		}
		return machineReadinessOutcome(diagnosis)
	}
	writeMachineReadinessPlan(command.ErrOrStderr(), *diagnosis.Plan)
	confirmed := yes
	if !confirmed {
		confirmed, err = confirmMachineReadinessPlan(
			command.InOrStdin(),
			command.ErrOrStderr(),
		)
		if err != nil {
			return err
		}
	}
	if !confirmed {
		if err := writeMachineReadinessResult(command.OutOrStdout(), diagnosis, format); err != nil {
			return err
		}
		return errors.New("repair was not confirmed; no changes were made")
	}
	operationID, err := dependencies.NewOperationID("doctor:fix")
	if err != nil {
		return err
	}
	repaired, err := runtime.client.Fix(command.Context(), machinereadiness.FixRequest{
		Selector:    selector,
		OperationID: operationID,
		PlanID:      diagnosis.Plan.ID,
	})
	if err != nil {
		return err
	}
	for attempt := 0; !repaired.Diagnosis.RepairSettled() &&
		attempt < dependencies.PollAttempts; attempt++ {
		if err := dependencies.Wait(command.Context(), dependencies.PollInterval); err != nil {
			return err
		}
		repaired.Diagnosis, err = runtime.client.Diagnose(command.Context(), selector)
		if err != nil {
			return err
		}
	}
	finalizeMachineReadinessRepair(&repaired)
	if err := writeMachineReadinessFixResult(command.OutOrStdout(), repaired, format); err != nil {
		return err
	}
	return machineReadinessRepairOutcome(repaired)
}

func doctorOutputFormat(format string, jsonOutput bool) (string, error) {
	if jsonOutput {
		if format != "text" && format != "json" {
			return "", errors.New("--format must be text or json")
		}
		return "json", nil
	}
	if format != "text" && format != "json" {
		return "", errors.New("--format must be text or json")
	}
	return format, nil
}

func finalizeMachineReadinessRepair(result *machinereadiness.FixResult) {
	switch result.Diagnosis.State {
	case machinereadiness.StateReady, machinereadiness.StateRepaired:
		result.State = "repaired"
		result.Diagnosis.State = machinereadiness.StateRepaired
		result.Diagnosis.Ready = true
		result.Diagnosis.Message = "The managed repair was verified and the machine is ready."
	case machinereadiness.StateRolledBack:
		result.State = "rolled-back"
	case machinereadiness.StateRecoveryRequired:
		result.State = "recovery-required"
	case machinereadiness.StateFailed:
		result.State = "failed"
	case machinereadiness.StateManuallyBlocked, machinereadiness.StateUnsupported,
		machinereadiness.StateAuthorizationRequired, machinereadiness.StateUnauthorized,
		machinereadiness.StateAmbiguous:
		result.State = "blocked"
	case machinereadiness.StateRepairing, machinereadiness.StateRollingBack:
		result.State = "repairing"
	default:
		result.State = "verification-pending"
	}
}

func writeMachineReadinessResult(
	output io.Writer,
	result machinereadiness.Result,
	format string,
) error {
	if format == "json" {
		return json.NewEncoder(output).Encode(result)
	}
	fmt.Fprintf(output, "Machine readiness: %s\n%s\n", result.State, result.Message)
	for _, check := range result.Checks {
		fmt.Fprintf(
			output,
			"- %s (%s): %s — %s\n",
			check.ConnectorName,
			check.ConnectorID,
			check.State,
			check.Summary,
		)
	}
	if result.Operation != nil && result.Operation.LastFailure != nil {
		fmt.Fprintf(
			output,
			"Last failure: %s\n",
			result.Operation.LastFailure.Message,
		)
	}
	if result.NextAction.Command != "" {
		fmt.Fprintf(output, "Next: %s\n", result.NextAction.Command)
	}
	return nil
}

func writeMachineReadinessFixResult(
	output io.Writer,
	result machinereadiness.FixResult,
	format string,
) error {
	if format == "json" {
		return json.NewEncoder(output).Encode(result)
	}
	fmt.Fprintf(output, "Repair outcome: %s\n", result.State)
	return writeMachineReadinessResult(output, result.Diagnosis, format)
}

func writeMachineReadinessPlan(output io.Writer, plan machinereadiness.RepairPlan) {
	fmt.Fprintf(output, "Managed repair plan %s:\n", plan.ID)
	for _, action := range plan.Actions {
		fmt.Fprintf(output, "- %s\n", action.Summary)
	}
}

func confirmMachineReadinessPlan(input io.Reader, output io.Writer) (bool, error) {
	fmt.Fprint(output, "Apply this exact managed repair plan? y/N: ")
	scanner := bufio.NewScanner(input)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return false, fmt.Errorf("read repair confirmation: %w", err)
		}
		return false, nil
	}
	answer := strings.ToLower(strings.TrimSpace(scanner.Text()))
	if answer == "" {
		return false, nil
	}
	return answer == "y" || answer == "yes", nil
}

func machineReadinessOutcome(result machinereadiness.Result) error {
	if result.Runnable() {
		return nil
	}
	return &codexOutcomeError{message: result.Message}
}

func machineReadinessRepairOutcome(result machinereadiness.FixResult) error {
	if result.State == "repaired" || result.State == "converged" {
		return nil
	}
	if result.State == "verification-pending" {
		return &codexOutcomeError{
			message: "the managed repair could not be verified; review the latest Doctor evidence",
		}
	}
	return machineReadinessOutcome(result.Diagnosis)
}
