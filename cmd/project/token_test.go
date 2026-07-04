package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

type commandCall struct {
	Args  []string
	Name  string
	Stdin string
}

func TestTokenCreateDryRunPlansFixedProjectsToken(t *testing.T) {
	var calls []commandCall
	runProjectTokenCommandTest(t, []string{"token", "create", "--dry-run", "--json"}, func(call commandCall) (string, error) {
		calls = append(calls, call)
		switch commandString(call) {
		case "op vault get projects":
			return "projects\n", nil
		case "op item list --vault projects --format json":
			return "[]", nil
		default:
			t.Fatalf("unexpected command: %s", commandString(call))
			return "", nil
		}
	})

	if calledCommand(calls, "op service-account create") {
		t.Fatal("dry-run created a service account")
	}
	if calledCommand(calls, "op item create") {
		t.Fatal("dry-run created a 1Password item")
	}
}

func TestTokenCreateStoresAndVerifiesTokenWithoutPrintingIt(t *testing.T) {
	const token = "SECRET-TOKEN"
	var createArgs []string
	var stored opPasswordItem

	output := runProjectTokenCommandTest(t, []string{"token", "create", "--yes"}, func(call commandCall) (string, error) {
		switch commandString(call) {
		case "op vault get projects":
			return "projects\n", nil
		case "op item list --vault projects --format json":
			return "[]", nil
		case "op service-account create project-ci --vault projects:read_items --raw":
			createArgs = call.Args
			return token + "\n", nil
		case "op item create --vault projects -":
			if err := json.Unmarshal([]byte(call.Stdin), &stored); err != nil {
				t.Fatalf("stored item was not valid JSON: %v", err)
			}
			return "{}\n", nil
		case "op read " + projectTokenRef:
			return token + "\n", nil
		default:
			t.Fatalf("unexpected command: %s", commandString(call))
			return "", nil
		}
	})

	if len(createArgs) == 0 {
		t.Fatal("service account create was not called")
	}
	if strings.Contains(output, token) {
		t.Fatalf("token leaked to output:\n%s", output)
	}
	if stored.Title != projectTokenItemTitle {
		t.Fatalf("stored title = %q, want %q", stored.Title, projectTokenItemTitle)
	}
	if got := stored.Fields[0].Value; got != token {
		t.Fatalf("stored token = %q, want token", got)
	}
}

func TestTokenCreateUsesExistingStableToken(t *testing.T) {
	var calls []commandCall
	output := runProjectTokenCommandTest(t, []string{"token", "create", "--dry-run"}, func(call commandCall) (string, error) {
		calls = append(calls, call)
		switch commandString(call) {
		case "op vault get projects":
			return "projects\n", nil
		case "op item list --vault projects --format json":
			return `[{"title":"Projects GitHub Actions Service Account"}]`, nil
		case "op read " + legacyProjectTokenRef:
			return "existing-token\n", nil
		default:
			t.Fatalf("unexpected command: %s", commandString(call))
			return "", nil
		}
	})

	if !strings.Contains(output, "Project token already exists.") {
		t.Fatalf("ready output missing:\n%s", output)
	}
	if calledCommand(calls, "op service-account create") {
		t.Fatal("created a token when the stable item already existed")
	}
}

func TestTokenCreateExpiresInCreatesTemporaryToken(t *testing.T) {
	fixedNow := time.Date(2026, 7, 2, 4, 5, 6, 0, time.UTC)
	var stored opPasswordItem
	output := runProjectTokenCommandTestWithClock(t, []string{"token", "create", "--expires-in", "24h", "--yes", "--json"}, fixedNow, func(call commandCall) (string, error) {
		switch commandString(call) {
		case "op vault get projects":
			return "projects\n", nil
		case "op service-account create project-temp-20260702-040506 --vault projects:read_items --raw --expires-in 24h":
			return "TEMP-TOKEN\n", nil
		case "op item create --vault projects -":
			if err := json.Unmarshal([]byte(call.Stdin), &stored); err != nil {
				t.Fatalf("stored item was not valid JSON: %v", err)
			}
			return "{}\n", nil
		case "op read op://projects/project-temp-service-account-20260702-040506-24h/password":
			return "TEMP-TOKEN\n", nil
		default:
			t.Fatalf("unexpected command: %s", commandString(call))
			return "", nil
		}
	})

	if !strings.Contains(output, `"expiresIn": "24h"`) {
		t.Fatalf("json output missing expiry:\n%s", output)
	}
	var result tokenCreateResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result.TokenRef, " ") {
		t.Fatalf("token reference contains spaces: %q", result.TokenRef)
	}
	if stored.Title != "project-temp-service-account-20260702-040506-24h" {
		t.Fatalf("stored title = %q", stored.Title)
	}
}

func TestTokenCreateRejectsInvalidExpiresIn(t *testing.T) {
	_, err := runProjectTokenCommandTestExpectError(t, []string{"token", "create", "--expires-in", "tomorrow", "--dry-run"}, func(call commandCall) (string, error) {
		t.Fatalf("unexpected command: %s", commandString(call))
		return "", nil
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "--expires-in must look like") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func runProjectTokenCommandTest(
	t *testing.T,
	args []string,
	handler func(commandCall) (string, error),
) string {
	output, err := runProjectTokenCommandTestExpectError(t, args, handler)
	if err != nil {
		t.Fatal(err)
	}
	return output
}

func runProjectTokenCommandTestWithClock(
	t *testing.T,
	args []string,
	clock time.Time,
	handler func(commandCall) (string, error),
) string {
	oldNow := now
	now = func() time.Time {
		return clock
	}
	t.Cleanup(func() {
		now = oldNow
	})
	return runProjectTokenCommandTest(t, args, handler)
}

func runProjectTokenCommandTestExpectError(
	t *testing.T,
	args []string,
	handler func(commandCall) (string, error),
) (string, error) {
	t.Helper()
	oldLookup := lookupExecutable
	oldRunner := runExternalCommand
	lookupExecutable = func(file string) (string, error) {
		if file != "op" {
			return "", fmt.Errorf("unexpected executable lookup: %s", file)
		}
		return "/usr/bin/op", nil
	}
	runExternalCommand = func(dir string, stdin []byte, name string, args ...string) (string, error) {
		return handler(commandCall{
			Args:  args,
			Name:  name,
			Stdin: string(stdin),
		})
	}
	t.Cleanup(func() {
		lookupExecutable = oldLookup
		runExternalCommand = oldRunner
	})

	cmd := newRootCommand()
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetArgs(args)

	err := cmd.Execute()
	return stdout.String(), err
}

func commandString(call commandCall) string {
	return strings.Join(append([]string{call.Name}, call.Args...), " ")
}

func calledCommand(calls []commandCall, prefix string) bool {
	for _, call := range calls {
		if strings.HasPrefix(commandString(call), prefix) {
			return true
		}
	}
	return false
}
