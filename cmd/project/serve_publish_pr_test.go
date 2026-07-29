//go:build !windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

func TestPublishPullRequestDevServerRegistersHeartbeatsAndReleases(t *testing.T) {
	var mutex sync.Mutex
	operations := []string{}
	payloads := map[string]map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer secret-token" {
			t.Errorf("authorization header = %q", request.Header.Get("Authorization"))
		}
		operation := request.URL.Path[len(pullRequestDevServerPath):]
		payload := map[string]any{}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Errorf("decode %s payload: %v", operation, err)
		}
		mutex.Lock()
		operations = append(operations, operation)
		payloads[operation] = payload
		mutex.Unlock()
		response.Header().Set("Content-Type", "application/json")
		if operation != "release" {
			_, _ = response.Write([]byte(
				`{"heartbeatIntervalSeconds":15,"lease":{"expiresAt":"2030-01-01T00:00:45Z","generation":2,"id":"lease-1"}}`,
			))
			return
		}
		_, _ = response.Write([]byte(`{"state":"released"}`))
	}))
	defer server.Close()

	manager := &fakeProjectCommandManager{serveResult: runningServeFixture()}
	sleepCalls := 0
	dependencies := pullRequestPublishDependencies{
		Client: server.Client(),
		Now:    func() time.Time { return time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC) },
		Sleep: func(context.Context, time.Duration) error {
			sleepCalls++
			if sleepCalls == 1 {
				return nil
			}
			return context.Canceled
		},
	}
	output := bytes.Buffer{}
	err := publishPullRequestDevServer(
		context.Background(),
		&output,
		manager,
		dependencies,
		machineconnect.Credential{
			BackendURL: server.URL,
			MachineID:  "connector-1",
			Token:      "secret-token",
		},
		"/tmp/worktree",
		pullRequestPublishOptions{
			BranchName:        "issue-356",
			CodexThreadID:     "thread-356",
			CommitSHA:         "0123456789012345678901234567890123456789",
			MachineID:         "11111111-1111-4111-8111-111111111111",
			ProjectID:         "project-1",
			PullRequestNumber: 356,
			Repository:        "DotNaos/project-space",
			Script:            "dev",
			ServedSurface:     "desktop-prototype",
			WorktreeID:        "worktree-1",
		},
	)
	if err != nil {
		t.Fatalf("publish live prototype: %v", err)
	}
	mutex.Lock()
	defer mutex.Unlock()
	if len(operations) != 3 ||
		operations[0] != "register" ||
		operations[1] != "heartbeat" ||
		operations[2] != "release" {
		t.Fatalf("operations = %#v", operations)
	}
	if payloads["register"]["connectorId"] != "connector-1" ||
		payloads["register"]["pullRequestNumber"] != float64(356) ||
		payloads["register"]["servedSurface"] != "desktop-prototype" {
		t.Fatalf("registration = %#v", payloads["register"])
	}
	runtime := payloads["heartbeat"]["runtime"].(map[string]any)
	if runtime["state"] != "running" ||
		runtime["tailscaleIpv4"] == "" ||
		runtime["tailscalePort"] == nil {
		t.Fatalf("heartbeat runtime = %#v", runtime)
	}
	if payloads["release"]["leaseId"] != "lease-1" ||
		payloads["release"]["generation"] != float64(2) {
		t.Fatalf("release = %#v", payloads["release"])
	}
}

func TestValidatePullRequestLeaseRejectsMissingIdentity(t *testing.T) {
	err := validatePullRequestLease(
		pullRequestDevServerLease{HeartbeatIntervalSeconds: 15},
		time.Now(),
	)
	if err == nil {
		t.Fatal("expected incomplete lease to be rejected")
	}
}
