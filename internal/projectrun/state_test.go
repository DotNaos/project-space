package projectrun

import (
	"strings"
	"testing"
)

func TestRuntimeStateValidationRejectsUnsafeOwnershipCombinations(t *testing.T) {
	base := runtimeState{
		Version:            SchemaVersion,
		ServerID:           "project-serve-repository-dev-123456789abc",
		RepositoryPath:     "/tmp/repository/.git",
		Directory:          "/tmp/repository",
		Script:             "dev",
		Mode:               ServeModeManaged,
		State:              StateRunning,
		Generation:         "generation-one",
		TmuxSession:        "project-serve-repository-dev-123456789abc",
		TmuxOwnershipToken: "ownership-one",
		PID:                1234,
		ProcessID:          "process-one",
		LocalPort:          43117,
		PublicPort:         44419,
		TailscaleIPv4:      "100.80.135.9",
		AllowedHosts:       []string{},
		CheckedAt:          "2026-08-11T12:00:00Z",
	}
	if err := validateRuntimeState(base); err != nil {
		t.Fatalf("valid state rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*runtimeState)
		want   string
	}{
		{"future schema", func(state *runtimeState) { state.Version++ }, "schema version"},
		{"unknown phase", func(state *runtimeState) { state.State = "foreign" }, "state"},
		{"unknown mode", func(state *runtimeState) { state.Mode = "foreign" }, "mode"},
		{"missing token", func(state *runtimeState) { state.TmuxOwnershipToken = "" }, "ownership token"},
		{"missing process identity", func(state *runtimeState) { state.ProcessID = "" }, "process identity"},
		{"invalid public port", func(state *runtimeState) { state.PublicPort = 70000 }, "public port"},
		{"managed route missing", func(state *runtimeState) { state.TailscaleIPv4 = "" }, "Tailscale"},
		{"unnormalized host", func(state *runtimeState) { state.AllowedHosts = []string{"B.example"} }, "allowed hosts"},
		{"local-only route", func(state *runtimeState) {
			state.Mode, state.State = ServeModeLocalOnly, StateLocalOnly
		}, "local-only state contains Tailscale"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			state := base
			state.AllowedHosts = append([]string{}, base.AllowedHosts...)
			test.mutate(&state)
			err := validateRuntimeState(state)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("validation error = %v, want %q", err, test.want)
			}
		})
	}
}
