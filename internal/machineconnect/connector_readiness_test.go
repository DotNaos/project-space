package machineconnect

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func readinessTestIdentity(machineID string) ConnectorRuntimeReadinessIdentity {
	return ConnectorRuntimeReadinessIdentity{
		MachineID:    machineID,
		BuildID:      strings.Repeat("a", 40),
		ReleaseID:    "v0.4.1",
		AttemptNonce: strings.Repeat("1", 64),
	}
}

func writeReadinessTestDocument(
	t *testing.T,
	path string,
	identity ConnectorRuntimeReadinessIdentity,
) {
	t.Helper()
	body, err := json.Marshal(connectorRuntimeReadinessDocument{
		Schema:       connectorRuntimeReadySchema,
		MachineID:    identity.MachineID,
		BuildID:      identity.BuildID,
		ReleaseID:    identity.ReleaseID,
		AttemptNonce: identity.AttemptNonce,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(body, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestWaitForConnectorRuntimeReadinessAcceptsOnlyExactIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), connectorRuntimeReadyName)
	expected := readinessTestIdentity("machine-191")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	writeDone := make(chan error, 1)
	go func() {
		time.Sleep(30 * time.Millisecond)
		body, err := json.Marshal(connectorRuntimeReadinessDocument{
			Schema:       connectorRuntimeReadySchema,
			MachineID:    expected.MachineID,
			BuildID:      expected.BuildID,
			ReleaseID:    expected.ReleaseID,
			AttemptNonce: expected.AttemptNonce,
		})
		if err == nil {
			err = os.WriteFile(path, append(body, '\n'), 0o600)
		}
		writeDone <- err
	}()
	if err := WaitForConnectorRuntimeReadiness(ctx, path, expected); err != nil {
		t.Fatalf("wait for matching readiness: %v", err)
	}
	if err := <-writeDone; err != nil {
		t.Fatalf("publish readiness fixture: %v", err)
	}
}

func TestWaitForConnectorRuntimeReadinessIgnoresMatchingOldAttemptAfterClear(t *testing.T) {
	path := filepath.Join(t.TempDir(), connectorRuntimeReadyName)
	expected := readinessTestIdentity("machine-191")
	oldAttempt := expected
	oldAttempt.AttemptNonce = strings.Repeat("2", 64)

	if err := ClearConnectorRuntimeReadiness(path); err != nil {
		t.Fatal(err)
	}
	writeReadinessTestDocument(t, path, oldAttempt)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	if err := WaitForConnectorRuntimeReadiness(ctx, path, expected); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("old-attempt wait error = %v, want deadline exceeded", err)
	}
}

func TestConnectorRuntimeReadinessAttemptIsRandomAndConsumedOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), connectorRuntimeReadyName)
	first, err := BeginConnectorRuntimeReadinessAttempt(path)
	if err != nil {
		t.Fatal(err)
	}
	if !validConnectorRuntimeReadinessNonce(first) {
		t.Fatalf("generated readiness attempt is invalid: %q", first)
	}
	attemptPath := connectorRuntimeReadinessAttemptPath(path)
	if info, err := os.Lstat(attemptPath); err != nil ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) ||
		!info.Mode().IsRegular() {
		t.Fatalf("readiness attempt is not a private regular file: info=%v err=%v", info, err)
	}
	consumed, found, err := ConsumeConnectorRuntimeReadinessAttempt(path)
	if err != nil || !found || consumed != first {
		t.Fatalf("consumed readiness attempt = %q found=%v err=%v", consumed, found, err)
	}
	if _, found, err := ConsumeConnectorRuntimeReadinessAttempt(path); err != nil || found {
		t.Fatalf("readiness attempt was consumed more than once: found=%v err=%v", found, err)
	}

	second, err := BeginConnectorRuntimeReadinessAttempt(path)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("successive readiness attempts reused a nonce")
	}
}

func TestWaitForConnectorRuntimeReadinessIgnoresWrongBuildUntilTimeout(t *testing.T) {
	path := filepath.Join(t.TempDir(), connectorRuntimeReadyName)
	expected := readinessTestIdentity("machine-191")
	wrong := expected
	wrong.BuildID = strings.Repeat("b", 40)
	writeReadinessTestDocument(t, path, wrong)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	if err := WaitForConnectorRuntimeReadiness(ctx, path, expected); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("wrong-build wait error = %v, want deadline exceeded", err)
	}
}

func TestClearConnectorRuntimeReadinessRejectsUnsafeDestination(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, connectorRuntimeReadyName)
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("target\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Skipf("create readiness symlink: %v", err)
	}
	if err := ClearConnectorRuntimeReadiness(path); err == nil {
		t.Fatal("unsafe readiness symlink was cleared as trusted evidence")
	}
	body, err := os.ReadFile(target)
	if err != nil || string(body) != "target\n" {
		t.Fatalf("readiness clear changed symlink target: %q, %v", body, err)
	}
}
