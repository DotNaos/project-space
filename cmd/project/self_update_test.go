package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/selfupdate"
)

type fakeSelfUpdateService struct {
	applyCalls  int
	applyErr    error
	apply       selfupdate.Result
	planOptions selfupdate.PlanOptions
	planErr     error
	plan        selfupdate.Plan
}

func (service *fakeSelfUpdateService) Plan(
	_ context.Context,
	options selfupdate.PlanOptions,
) (selfupdate.Plan, error) {
	service.planOptions = options
	return service.plan, service.planErr
}

func (service *fakeSelfUpdateService) Apply(
	context.Context,
	selfupdate.Plan,
	io.Writer,
	io.Writer,
) (selfupdate.Result, error) {
	service.applyCalls++
	return service.apply, service.applyErr
}

func availableManagedMigrationPlan() selfupdate.Plan {
	return selfupdate.Plan{
		MigrateManaged: true,
		Result: selfupdate.Result{
			CurrentVersion:    "0.4.8",
			InstallSource:     selfupdate.InstallSourceHomebrew,
			ManagedInstallDir: "/Users/test/.local/bin",
			MigrateManaged:    true,
			PreservedState:    "machine identity and credential",
			RollbackBehavior:  "restore the previous service",
			ServiceTransition: "replace the service and prove authenticated readiness",
			State:             selfupdate.StateUpdateAvailable,
			TargetVersion:     "0.4.8",
		},
	}
}

func availableSelfUpdatePlan() selfupdate.Plan {
	return selfupdate.Plan{Result: selfupdate.Result{
		CurrentVersion: "0.4.7",
		InstallSource:  selfupdate.InstallSourceManaged,
		State:          selfupdate.StateUpdateAvailable,
		TargetVersion:  "0.4.8",
	}}
}

func executeSelfUpdateCommand(
	t *testing.T,
	service *fakeSelfUpdateService,
	input io.Reader,
	args ...string,
) (string, error) {
	t.Helper()
	command := newSelfUpdateCommandWithService(service)
	command.SilenceUsage = true
	command.SilenceErrors = true
	output := &bytes.Buffer{}
	command.SetOut(output)
	command.SetErr(io.Discard)
	command.SetIn(input)
	command.SetArgs(args)
	err := command.Execute()
	return output.String(), err
}

func TestSelfUpdateCheckIsReadOnly(t *testing.T) {
	service := &fakeSelfUpdateService{plan: availableSelfUpdatePlan()}
	output, err := executeSelfUpdateCommand(t, service, strings.NewReader("yes\n"), "--check")
	if err != nil {
		t.Fatal(err)
	}
	if service.applyCalls != 0 || !strings.Contains(output, "State: update-available") || strings.Contains(output, "y/N") {
		t.Fatalf("output = %q, calls = %d", output, service.applyCalls)
	}
}

func TestSelfUpdateInteractiveConfirmationDefaultsToNo(t *testing.T) {
	for _, answer := range []string{"\n", "n\n", "maybe\n", ""} {
		service := &fakeSelfUpdateService{plan: availableSelfUpdatePlan()}
		output, err := executeSelfUpdateCommand(t, service, strings.NewReader(answer))
		if err != nil {
			t.Fatal(err)
		}
		if service.applyCalls != 0 || !strings.Contains(output, "y/N") || !strings.Contains(output, "Update cancelled") {
			t.Fatalf("answer %q: output = %q, calls = %d", answer, output, service.applyCalls)
		}
	}
}

func TestSelfUpdateInteractiveYesApplies(t *testing.T) {
	for _, answer := range []string{"y\n", "YES\n"} {
		service := &fakeSelfUpdateService{
			plan:  availableSelfUpdatePlan(),
			apply: selfupdate.Result{CurrentVersion: "0.4.7", InstallSource: selfupdate.InstallSourceManaged, State: selfupdate.StateUpdated, TargetVersion: "0.4.8"},
		}
		output, err := executeSelfUpdateCommand(t, service, strings.NewReader(answer))
		if err != nil {
			t.Fatal(err)
		}
		if service.applyCalls != 1 || !strings.Contains(output, "State: updated") {
			t.Fatalf("answer %q: output = %q, calls = %d", answer, output, service.applyCalls)
		}
	}
}

type failingSelfUpdateReader struct{}

func (failingSelfUpdateReader) Read([]byte) (int, error) {
	return 0, errors.New("stdin must not be read")
}

func TestSelfUpdateJSONNeverPrompts(t *testing.T) {
	service := &fakeSelfUpdateService{plan: availableSelfUpdatePlan()}
	output, err := executeSelfUpdateCommand(t, service, failingSelfUpdateReader{}, "--format", "json")
	if err != nil {
		t.Fatal(err)
	}
	var result selfupdate.Result
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("JSON output = %q: %v", output, err)
	}
	if result.State != selfupdate.StateUpdateAvailable || service.applyCalls != 0 {
		t.Fatalf("result = %#v, calls = %d", result, service.applyCalls)
	}
}

func TestSelfUpdateYesJSONAppliesWithoutPrompt(t *testing.T) {
	service := &fakeSelfUpdateService{
		plan:  availableSelfUpdatePlan(),
		apply: selfupdate.Result{CurrentVersion: "0.4.7", InstallSource: selfupdate.InstallSourceManaged, State: selfupdate.StateUpdated, TargetVersion: "0.4.8"},
	}
	output, err := executeSelfUpdateCommand(t, service, failingSelfUpdateReader{}, "--yes", "--format", "json")
	if err != nil {
		t.Fatal(err)
	}
	var result selfupdate.Result
	if err := json.Unmarshal([]byte(output), &result); err != nil || result.State != selfupdate.StateUpdated || service.applyCalls != 1 {
		t.Fatalf("output = %q, result = %#v, error = %v, calls = %d", output, result, err, service.applyCalls)
	}
}

func TestSelfUpdateManagedMigrationCheckAndJSONAreReadOnly(t *testing.T) {
	for _, args := range [][]string{
		{"--migrate-managed", "--check"},
		{"--migrate-managed", "--format", "json"},
	} {
		service := &fakeSelfUpdateService{plan: availableManagedMigrationPlan()}
		output, err := executeSelfUpdateCommand(
			t,
			service,
			failingSelfUpdateReader{},
			args...,
		)
		if err != nil {
			t.Fatal(err)
		}
		if !service.planOptions.MigrateManaged || service.applyCalls != 0 ||
			!strings.Contains(output, "/Users/test/.local/bin") {
			t.Fatalf("args = %#v, output = %q, service = %#v", args, output, service)
		}
	}
}

func TestSelfUpdateManagedMigrationConfirmsAndAppliesSameVersion(t *testing.T) {
	for _, test := range []struct {
		name  string
		input io.Reader
		args  []string
	}{
		{name: "interactive", input: strings.NewReader("yes\n"), args: []string{"--migrate-managed"}},
		{name: "yes json", input: failingSelfUpdateReader{}, args: []string{"--migrate-managed", "--yes", "--format", "json"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &fakeSelfUpdateService{
				plan: availableManagedMigrationPlan(),
				apply: selfupdate.Result{
					CurrentVersion: "0.4.8",
					InstallSource:  selfupdate.InstallSourceHomebrew,
					MigrateManaged: true,
					State:          selfupdate.StateUpdated,
					TargetVersion:  "0.4.8",
				},
			}
			output, err := executeSelfUpdateCommand(t, service, test.input, test.args...)
			if err != nil || service.applyCalls != 1 ||
				!service.planOptions.MigrateManaged ||
				!strings.Contains(output, string(selfupdate.StateUpdated)) {
				t.Fatalf("output = %q, error = %v, service = %#v", output, err, service)
			}
		})
	}
}

func TestSelfUpdateRejectsConflictingAndUnknownFlags(t *testing.T) {
	service := &fakeSelfUpdateService{plan: availableSelfUpdatePlan()}
	if _, err := executeSelfUpdateCommand(t, service, strings.NewReader(""), "--check", "--yes"); err == nil {
		t.Fatal("--check --yes succeeded")
	}
	if _, err := executeSelfUpdateCommand(t, service, strings.NewReader(""), "--format", "yaml"); err == nil {
		t.Fatal("unknown format succeeded")
	}
	if service.applyCalls != 0 {
		t.Fatalf("apply calls = %d", service.applyCalls)
	}
}

func TestSelfUpdateJSONReportsAllTerminalStates(t *testing.T) {
	states := []selfupdate.State{
		selfupdate.StateCurrent,
		selfupdate.StateUnsupportedSource,
		selfupdate.StateVerificationFailed,
		selfupdate.StateUpdateFailed,
		selfupdate.StateRolledBack,
		selfupdate.StateUpdated,
	}
	for _, state := range states {
		t.Run(string(state), func(t *testing.T) {
			result := selfupdate.Result{
				ActionableBlocker: "fixture blocker",
				CurrentVersion:    "0.4.7",
				InstallSource:     selfupdate.InstallSourceManaged,
				State:             state,
				TargetVersion:     "0.4.8",
			}
			service := &fakeSelfUpdateService{}
			args := []string{"--format", "json"}
			switch state {
			case selfupdate.StateUpdated, selfupdate.StateRolledBack, selfupdate.StateUpdateFailed:
				service.plan = availableSelfUpdatePlan()
				service.apply = result
				args = append(args, "--yes")
				if state != selfupdate.StateUpdated {
					service.applyErr = errors.New("fixture failure")
				}
			case selfupdate.StateVerificationFailed:
				service.plan = selfupdate.Plan{Result: result}
				service.planErr = errors.New("fixture verification failure")
			default:
				service.plan = selfupdate.Plan{Result: result}
			}
			output, commandErr := executeSelfUpdateCommand(t, service, failingSelfUpdateReader{}, args...)
			var decoded selfupdate.Result
			if err := json.Unmarshal([]byte(output), &decoded); err != nil {
				t.Fatalf("output = %q: %v", output, err)
			}
			if decoded.State != state || decoded.ActionableBlocker != result.ActionableBlocker {
				t.Fatalf("decoded = %#v", decoded)
			}
			wantErr := state == selfupdate.StateUnsupportedSource || state == selfupdate.StateVerificationFailed || state == selfupdate.StateRolledBack || state == selfupdate.StateUpdateFailed
			if (commandErr != nil) != wantErr {
				t.Fatalf("command error = %v, wantErr %v", commandErr, wantErr)
			}
		})
	}
}
