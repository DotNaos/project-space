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
	applyCalls int
	applyErr   error
	apply      selfupdate.Result
	planErr    error
	plan       selfupdate.Plan
}

func (service *fakeSelfUpdateService) Plan(context.Context) (selfupdate.Plan, error) {
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
