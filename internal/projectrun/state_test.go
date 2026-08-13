package projectrun

import (
	"encoding/json"
	"os"
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
		APIs:               APIsModeExternal,
		Data:               DataModeRemote,
		State:              StateRunning,
		Generation:         "generation-one",
		TmuxSession:        "project-serve-repository-dev-123456789abc",
		TmuxOwnershipToken: "ownership-one",
		PID:                1234,
		ProcessID:          "process-one",
		LocalPort:          43117,
		PortlessName:       "repository",
		PortlessURL:        "http://repository.localhost:1355",
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
		{"missing APIs binding", func(state *runtimeState) { state.APIs = "" }, "APIs mode"},
		{"missing data binding", func(state *runtimeState) { state.Data = "" }, "data mode"},
		{"simulated remote data", func(state *runtimeState) {
			state.APIs, state.Data = APIsModeSimulated, DataModeRemote
		}, "simulated APIs"},
		{"missing token", func(state *runtimeState) { state.TmuxOwnershipToken = "" }, "ownership token"},
		{"missing process identity", func(state *runtimeState) { state.ProcessID = "" }, "process identity"},
		{"invalid public port", func(state *runtimeState) { state.PublicPort = 70000 }, "public port"},
		{"managed route missing", func(state *runtimeState) { state.TailscaleIPv4 = "" }, "Tailscale"},
		{"Portless route missing", func(state *runtimeState) { state.PortlessURL = "" }, "Portless"},
		{"Portless route changed", func(state *runtimeState) {
			state.PortlessURL = "http://foreign.localhost:1355"
		}, "Portless"},
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

func TestLegacyRuntimeBindingsNormalizeInLoadAndList(t *testing.T) {
	store, err := newStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	identity := ServerIdentity{
		ServerID:       "project-serve-repository-dev-123456789abc",
		RepositoryPath: "/tmp/repository/.git",
		WorktreePath:   "/tmp/repository",
		ServerKey:      "dev",
		TmuxSession:    "project-serve-repository-dev-123456789abc",
	}
	legacy := runtimeState{
		Version: SchemaVersion, ServerID: identity.ServerID, RepositoryPath: identity.RepositoryPath,
		Directory: identity.WorktreePath, Script: identity.ServerKey, Mode: ServeModeManaged,
		State: StateStale, Generation: "generation-one", TmuxSession: identity.TmuxSession,
		TmuxOwnershipToken: "ownership-one", AllowedHosts: []string{}, CheckedAt: "2026-08-11T12:00:00Z",
		Companions: []CompanionServer{{
			Library: "/tmp/library", Script: "prototype", Directory: "/tmp/library",
			ServerID: "project-serve-library-prototype-123456789abc", Created: true,
		}},
		Watchers: []LocalNodeWatcher{{
			Package: "@example/legacy", Directory: "/tmp/library", Command: []string{"bun", "run", "watch"},
			PID: 1235, ProcessIdentity: "watcher-one", LogPath: "/tmp/legacy-watcher.log",
		}},
	}
	body, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.statePath(identity.ServerID), body, 0o600); err != nil {
		t.Fatal(err)
	}

	loaded, found, err := store.load(identity)
	if err != nil || !found {
		t.Fatalf("load legacy state: found=%t err=%v", found, err)
	}
	if loaded.APIs != APIsModeExternal || loaded.Data != DataModeRemote {
		t.Fatalf("loaded bindings = %s/%s", loaded.APIs, loaded.Data)
	}
	if !loaded.Companions[0].Owned || loaded.Watchers[0].ExitPath != "" {
		t.Fatalf("loaded legacy ownership = companions=%#v watchers=%#v", loaded.Companions, loaded.Watchers)
	}
	listing, err := store.list()
	if err != nil || len(listing.States) != 1 || len(listing.Failures) != 0 {
		t.Fatalf("list legacy state: %#v err=%v", listing, err)
	}
	if listing.States[0].APIs != APIsModeExternal || listing.States[0].Data != DataModeRemote {
		t.Fatalf("listed bindings = %s/%s", listing.States[0].APIs, listing.States[0].Data)
	}
	if !listing.States[0].Companions[0].Owned {
		t.Fatalf("listed legacy companion was not migrated: %#v", listing.States[0].Companions)
	}
}
