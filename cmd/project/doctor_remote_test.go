package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/machinereadiness"
	"github.com/spf13/cobra"
)

type doctorReadinessAPI struct {
	diagnoses []machinereadiness.Result
	fixCalls  []machinereadiness.FixRequest
	fixResult machinereadiness.FixResult
}

func (api *doctorReadinessAPI) Diagnose(
	context.Context,
	machinereadiness.Selector,
) (machinereadiness.Result, error) {
	result := api.diagnoses[0]
	if len(api.diagnoses) > 1 {
		api.diagnoses = api.diagnoses[1:]
	}
	return result, nil
}

func (api *doctorReadinessAPI) Fix(
	_ context.Context,
	request machinereadiness.FixRequest,
) (machinereadiness.FixResult, error) {
	api.fixCalls = append(api.fixCalls, request)
	return api.fixResult, nil
}

func TestRemoteDoctorDiagnosisIsReadOnlyAndStructured(t *testing.T) {
	api := &doctorReadinessAPI{diagnoses: []machinereadiness.Result{
		repairableDoctorResult(),
	}}
	command := remoteDoctorCommand(api)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetArgs([]string{"--machine", "os-pc", "--format", "json"})
	command.SilenceUsage = true

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "managed connector restart") {
		t.Fatalf("diagnosis error = %v", err)
	}
	if len(api.fixCalls) != 0 {
		t.Fatalf("read-only diagnosis called fix: %#v", api.fixCalls)
	}
	var result machinereadiness.Result
	if json.Unmarshal(output.Bytes(), &result) != nil || result.State != machinereadiness.StateRepairable {
		t.Fatalf("structured diagnosis = %q", output.String())
	}
}

func TestRemoteDoctorFixNeedsConfirmation(t *testing.T) {
	api := &doctorReadinessAPI{diagnoses: []machinereadiness.Result{
		repairableDoctorResult(),
	}}
	command := remoteDoctorCommand(api)
	command.SetOut(&bytes.Buffer{})
	command.SetErr(&bytes.Buffer{})
	command.SetIn(strings.NewReader("n\n"))
	command.SetArgs([]string{"--machine", "os-pc", "--fix"})
	command.SilenceUsage = true

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "not confirmed") {
		t.Fatalf("confirmation error = %v", err)
	}
	if len(api.fixCalls) != 0 {
		t.Fatalf("declined plan called fix: %#v", api.fixCalls)
	}
}

func TestRemoteDoctorYesAppliesTheExactPlanAndVerifiesReadiness(t *testing.T) {
	initial := repairableDoctorResult()
	staleAfterDispatch := initial
	staleAfterDispatch.State = machinereadiness.StateDegraded
	ready := initial
	ready.State = machinereadiness.StateReady
	ready.Ready = true
	ready.Plan = nil
	ready.Message = "Ready."
	api := &doctorReadinessAPI{
		diagnoses: []machinereadiness.Result{initial, ready},
		fixResult: machinereadiness.FixResult{
			APIVersion:  machinereadiness.APIVersion,
			Diagnosis:   staleAfterDispatch,
			OperationID: "doctor:fixed",
			State:       "verification-pending",
		},
	}
	command := remoteDoctorCommand(api)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"--machine", "os-pc", "--fix", "--yes", "--json"})
	command.SilenceUsage = true

	if err := command.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if len(api.fixCalls) != 1 ||
		api.fixCalls[0].PlanID != initial.Plan.ID ||
		api.fixCalls[0].PhysicalMachineName != "os-pc" {
		t.Fatalf("fix request = %#v", api.fixCalls)
	}
	var result machinereadiness.FixResult
	if json.Unmarshal(output.Bytes(), &result) != nil ||
		result.State != "repaired" ||
		result.Diagnosis.State != machinereadiness.StateRepaired {
		t.Fatalf("verified result = %q", output.String())
	}
}

func TestRemoteDoctorDoesNotClaimRepairWhenVerificationTimesOut(t *testing.T) {
	initial := repairableDoctorResult()
	staleAfterDispatch := initial
	staleAfterDispatch.State = machinereadiness.StateDegraded
	api := &doctorReadinessAPI{
		diagnoses: []machinereadiness.Result{initial, staleAfterDispatch},
		fixResult: machinereadiness.FixResult{
			APIVersion:  machinereadiness.APIVersion,
			Diagnosis:   staleAfterDispatch,
			OperationID: "doctor:fixed",
			State:       "verification-pending",
		},
	}
	command := remoteDoctorCommand(api)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"--machine", "os-pc", "--fix", "--yes", "--json"})
	command.SilenceUsage = true

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "could not be verified") {
		t.Fatalf("verification error = %v", err)
	}
	var result machinereadiness.FixResult
	if json.Unmarshal(output.Bytes(), &result) != nil ||
		result.State != "verification-pending" ||
		result.Diagnosis.State != machinereadiness.StateDegraded {
		t.Fatalf("unverified result = %q", output.String())
	}
}

func TestRemoteDoctorReportsSafePartialMaintenanceAsBlocked(t *testing.T) {
	initial := repairableDoctorResult()
	initial.State = machinereadiness.StateManuallyBlocked
	initial.Message = "No managed Codex installation is available."
	initial.Plan.Actions[0] = machinereadiness.RepairAction{
		ConnectorID: "linux-stable",
		Kind:        "update-connector",
		Operation:   "update",
		ReleaseID:   "v0.4.10",
		Summary:     "Install signed managed connector release v0.4.10.",
	}
	blocked := initial
	blocked.Plan = nil
	api := &doctorReadinessAPI{
		diagnoses: []machinereadiness.Result{initial},
		fixResult: machinereadiness.FixResult{
			APIVersion:  machinereadiness.APIVersion,
			Diagnosis:   blocked,
			OperationID: "doctor:fixed",
			State:       "blocked",
		},
	}
	command := remoteDoctorCommand(api)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"--machine", "os-pc", "--fix", "--yes", "--json"})
	command.SilenceUsage = true

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "No managed Codex") {
		t.Fatalf("blocked error = %v", err)
	}
	var result machinereadiness.FixResult
	if json.Unmarshal(output.Bytes(), &result) != nil ||
		result.State != "blocked" ||
		result.Diagnosis.State != machinereadiness.StateManuallyBlocked {
		t.Fatalf("partial result = %q", output.String())
	}
}

func TestRemoteDoctorKeepsRollbackOutcomeBlocked(t *testing.T) {
	initial := repairableDoctorResult()
	rolledBack := initial
	rolledBack.State = machinereadiness.StateRolledBack
	rolledBack.Plan = nil
	rolledBack.Message = "The update rolled back."
	api := &doctorReadinessAPI{
		diagnoses: []machinereadiness.Result{initial},
		fixResult: machinereadiness.FixResult{
			APIVersion:  machinereadiness.APIVersion,
			Diagnosis:   rolledBack,
			OperationID: "doctor:fixed",
			State:       "rolled-back",
		},
	}
	command := remoteDoctorCommand(api)
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(&bytes.Buffer{})
	command.SetArgs([]string{"--machine", "os-pc", "--fix", "--yes", "--json"})
	command.SilenceUsage = true

	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "rolled back") {
		t.Fatalf("rollback error = %v", err)
	}
	var result machinereadiness.FixResult
	if json.Unmarshal(output.Bytes(), &result) != nil || result.State != "rolled-back" {
		t.Fatalf("rollback result = %q", output.String())
	}
}

func remoteDoctorCommand(api machineReadinessAPI) *cobra.Command {
	return newMachineDoctorCommandWithAllDependencies(
		func() (machineConnectionCommandDependencies, error) {
			panic("remote Doctor must not load local dependencies")
		},
		projectDirectoryDoctor{},
		machineReadinessCommandDependencies{
			LoadRuntime: func(context.Context) (machineReadinessCommandRuntime, error) {
				return machineReadinessCommandRuntime{client: api}, nil
			},
			NewOperationID: func(string) (string, error) {
				return "doctor:fixed", nil
			},
			PollAttempts: 3,
			PollInterval: time.Millisecond,
			Wait: func(context.Context, time.Duration) error {
				return nil
			},
		},
	)
}

func repairableDoctorResult() machinereadiness.Result {
	result := machinereadiness.Result{
		APIVersion: machinereadiness.APIVersion,
		CheckedAt:  "2026-07-24T00:00:00.000Z",
		Message:    "A constrained managed connector restart can make this machine ready.",
		Plan: &machinereadiness.RepairPlan{
			Actions: []machinereadiness.RepairAction{{
				ConnectorID: "linux-stable",
				Kind:        "restart-connector",
				Operation:   "restart",
				Summary:     "Restart the managed connector through its constrained maintenance channel.",
			}},
			ID: strings.Repeat("a", 64),
		},
		State: machinereadiness.StateRepairable,
	}
	result.NextAction.Kind = "doctor-fix"
	result.NextAction.Message = "Review and confirm the exact managed repair plan."
	return result
}
