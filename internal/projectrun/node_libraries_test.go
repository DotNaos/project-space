package projectrun

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDiscoverLocalNodeLibrariesResolvesWorkspaceSourceExports(t *testing.T) {
	library := writeNodeLibraryFixture(t, "@example/alpha", true)
	mustWriteTestFile(t, filepath.Join(library, "packages/alpha/src/index.ts"), "export const dirty = true\n")
	libraries, err := discoverLocalNodeLibraries(context.Background(), t.TempDir(), []string{library, library})
	if err != nil {
		t.Fatal(err)
	}
	if len(libraries) != 1 || !libraries[0].Dirty || libraries[0].Branch != "main" ||
		!reflect.DeepEqual(libraries[0].CompanionServers, []string{"prototype"}) {
		t.Fatalf("library discovery = %#v", libraries)
	}
	packages := libraries[0].Packages
	if len(packages) != 2 || packages[0].Name != "@example/alpha" || packages[1].Name != "@example/beta" {
		t.Fatalf("packages = %#v", packages)
	}
	if packages[0].Mode != "source" || len(packages[0].Imports) != 2 {
		t.Fatalf("alpha package = %#v", packages[0])
	}
	for _, entry := range packages[0].Imports {
		if !strings.Contains(entry.Path, string(filepath.Separator)+"src"+string(filepath.Separator)) {
			t.Fatalf("source export did not resolve into src: %#v", entry)
		}
	}
}

func TestDiscoverLocalNodeLibrariesRejectsDuplicatePackageOwners(t *testing.T) {
	first := writeNodeLibraryFixture(t, "@example/shared", false)
	second := writeNodeLibraryFixture(t, "@example/shared", false)
	_, err := discoverLocalNodeLibraries(context.Background(), t.TempDir(), []string{first, second})
	if err == nil || !strings.Contains(err.Error(), "provided by both") {
		t.Fatalf("duplicate owner error = %v", err)
	}
}

func TestLocalNodeLibraryBindingIgnoresGitSnapshotMetadata(t *testing.T) {
	first := []LocalNodeLibrary{{
		Directory: "/tmp/ui", Repository: "/tmp/ui", Branch: "main", Revision: "old", Dirty: false,
		Packages: []LocalNodePackage{{Name: "@example/ui", Directory: "/tmp/ui/package", Mode: "source"}},
	}}
	second := []LocalNodeLibrary{{
		Directory: "/tmp/ui", Repository: "/tmp/ui", Branch: "feature", Revision: "new", Dirty: true,
		Packages: []LocalNodePackage{{Name: "@example/ui", Directory: "/tmp/ui/package", Mode: "source"}},
	}}
	if !sameLocalNodeLibraryBindings(first, second) {
		t.Fatal("Git snapshot metadata changed the live library binding")
	}
	second[0].Packages[0].Directory = "/tmp/ui/other-package"
	if sameLocalNodeLibraryBindings(first, second) {
		t.Fatal("a changed package mapping was accepted as the same binding")
	}
}

func TestManagedServePersistsAndCleansLocalNodeLibraryManifest(t *testing.T) {
	consumer := writeTestScripts(t)
	library := writeNodeLibraryFixture(t, "@example/alpha", false)
	manager, processes, _, _ := newTestManager(t)
	started, err := manager.StartWithOptions(context.Background(), consumer, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(started.Libraries) != 1 || len(started.Libraries[0].Packages) != 2 {
		t.Fatalf("serve libraries = %#v", started.Libraries)
	}
	manifestPath := environmentMap(processes.started[0].Env)["PROJECT_SERVE_WITH"]
	if manifestPath == "" {
		t.Fatalf("managed command has no local library manifest: %#v", processes.started[0].Env)
	}
	body, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest := localNodeLibrariesManifest{}
	if err := json.Unmarshal(body, &manifest); err != nil || manifest.Version != 1 || len(manifest.Libraries) != 1 {
		t.Fatalf("manifest = %#v err=%v", manifest, err)
	}
	if _, err := manager.StartWithOptions(context.Background(), consumer, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal,
	}); err == nil || !strings.Contains(err.Error(), "different --with libraries") {
		t.Fatalf("changed libraries error = %v", err)
	}
	if _, err := manager.Stop(context.Background(), consumer, "dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(manifestPath); !os.IsNotExist(err) {
		t.Fatalf("local library manifest remains after stop: %v", err)
	}
}

func TestManagedServeRestartRemovesPreviousGenerationLibraryArtifacts(t *testing.T) {
	consumer := writeTestScripts(t)
	library := writeNodeLibraryFixture(t, "@example/alpha", false)
	manager, processes, _, _ := newTestManager(t)
	tmux := manager.tmux.(*fakeTmux)
	first, err := manager.StartWithOptions(context.Background(), consumer, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library},
	})
	if err != nil {
		t.Fatal(err)
	}
	oldManifest := manager.store.localLibrariesPath(first.ServerID, first.ServerGeneration)
	observation := tmux.sessions[first.TmuxSession]
	if err := processes.StopGroup(observation.Process, time.Second); err != nil {
		t.Fatal(err)
	}
	tmux.mutex.Lock()
	delete(tmux.sessions, first.TmuxSession)
	tmux.mutex.Unlock()
	second, err := manager.StartWithOptions(context.Background(), consumer, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library},
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.ServerGeneration == first.ServerGeneration {
		t.Fatal("unhealthy session reused its previous generation")
	}
	if _, err := os.Stat(oldManifest); !os.IsNotExist(err) {
		t.Fatalf("previous generation manifest remains: %v", err)
	}
}

func TestManagedServeStartsAndStopsDeclaredLibraryCompanion(t *testing.T) {
	consumer := writeTestScripts(t)
	library := writeNodeLibraryFixture(t, "@example/alpha", true)
	ports := &sequencePorts{local: []int{43117, 43118}, public: []int{44419}}
	manager, processes, _, _ := newTestManagerWithPorts(t, ports)
	started, err := manager.StartWithOptions(context.Background(), consumer, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(started.Companions) != 1 || !started.Companions[0].Created || started.Companions[0].LocalURL == nil {
		t.Fatalf("companions = %#v", started.Companions)
	}
	if len(processes.started) != 2 {
		t.Fatalf("started processes = %d", len(processes.started))
	}
	if _, err := manager.Stop(context.Background(), consumer, "dev"); err != nil {
		t.Fatal(err)
	}
	if len(processes.stopped) != 2 {
		t.Fatalf("stopped processes = %d", len(processes.stopped))
	}
}

func TestManagedServeSharesOwnedLibraryCompanionUntilLastConsumerStops(t *testing.T) {
	firstConsumer := writeTestScripts(t)
	secondConsumer := writeTestScripts(t)
	library := writeNodeLibraryFixture(t, "@example/alpha", true)
	ports := &sequencePorts{local: []int{43117, 43118, 43119}, public: []int{44419}}
	manager, processes, _, _ := newTestManagerWithPorts(t, ports)
	options := StartOptions{LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library}}
	first, err := manager.StartWithOptions(context.Background(), firstConsumer, "dev", options)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.StartWithOptions(context.Background(), secondConsumer, "dev", options)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Companions[0].Owned || !second.Companions[0].Owned || second.Companions[0].Created {
		t.Fatalf("shared companions first=%#v second=%#v", first.Companions, second.Companions)
	}
	if _, err := manager.Stop(context.Background(), firstConsumer, "dev"); err != nil {
		t.Fatal(err)
	}
	if len(processes.stopped) != 1 {
		t.Fatalf("first stop terminated shared companion: stopped=%d", len(processes.stopped))
	}
	if _, err := manager.Status(context.Background(), secondConsumer, "dev"); err != nil {
		t.Fatalf("second consumer lost shared companion: %v", err)
	}
	if _, err := manager.Stop(context.Background(), secondConsumer, "dev"); err != nil {
		t.Fatal(err)
	}
	if len(processes.stopped) != 3 {
		t.Fatalf("last stop did not clean both primary and companion: stopped=%d", len(processes.stopped))
	}
}

func TestManagedServeLeavesPreexistingCompanionRunning(t *testing.T) {
	consumer := writeTestScripts(t)
	library := writeNodeLibraryFixture(t, "@example/alpha", true)
	ports := &sequencePorts{local: []int{43117, 43118}, public: []int{44419}}
	manager, processes, _, _ := newTestManagerWithPorts(t, ports)
	if _, err := manager.StartWithOptions(context.Background(), library, "prototype", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal,
	}); err != nil {
		t.Fatal(err)
	}
	started, err := manager.StartWithOptions(context.Background(), consumer, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library},
	})
	if err != nil {
		t.Fatal(err)
	}
	if started.Companions[0].Owned || started.Companions[0].Created {
		t.Fatalf("preexisting companion became overlay-owned: %#v", started.Companions[0])
	}
	if _, err := manager.Stop(context.Background(), consumer, "dev"); err != nil {
		t.Fatal(err)
	}
	if len(processes.stopped) != 1 {
		t.Fatalf("consumer stop terminated preexisting companion: stopped=%d", len(processes.stopped))
	}
	if _, err := manager.Status(context.Background(), library, "prototype"); err != nil {
		t.Fatalf("preexisting companion became unhealthy: %v", err)
	}
}

func TestManagedServeRetainsCompanionOwnershipWhenRollbackFails(t *testing.T) {
	consumer := writeTestScripts(t)
	library := writeNodeLibraryFixture(t, "@example/alpha", false)
	mustWriteTestFile(t, filepath.Join(library, scriptsConfigPath), "version: 2\nsetup:\n  - id: dependencies\n    command: [bun, install]\nservers:\n  prototype-a:\n    prototypeSurface: desktop-prototype\n    command: [test-server, --host, \"{host}\", --port, \"{port}\"]\n    healthCheck:\n      path: /health\n      timeoutSeconds: 2\n  prototype-b:\n    prototypeSurface: desktop-prototype\n    command: [test-server, --host, \"{host}\", --port, \"{port}\"]\n    healthCheck:\n      path: /health\n      timeoutSeconds: 2\n")
	ports := &sequencePorts{local: []int{43117, 43118, 43119}, public: []int{44419}}
	manager, processes, _, _ := newTestManagerWithPorts(t, ports)
	processes.startErrAt = 3
	processes.stopErr = errors.New("injected process stop failure")

	_, err := manager.StartWithOptions(context.Background(), consumer, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library},
	})
	if err == nil || !strings.Contains(err.Error(), "injected process start failure") ||
		!strings.Contains(err.Error(), "injected process stop failure") {
		t.Fatalf("companion rollback error = %v", err)
	}
	identity := mustTestIdentity(t, manager, consumer, "dev")
	state, found, loadErr := manager.store.load(identity)
	if loadErr != nil || !found {
		t.Fatalf("load failed consumer state: found=%t err=%v", found, loadErr)
	}
	if state.State != StateError || len(state.Companions) != 1 || !state.Companions[0].Owned {
		t.Fatalf("failed rollback lost companion ownership evidence: %#v", state.Companions)
	}
}

func TestManagedServeClearsFailedConsumerBeforeReusingCompanion(t *testing.T) {
	firstConsumer := writeTestScripts(t)
	secondConsumer := writeTestScripts(t)
	library := writeNodeLibraryFixture(t, "@example/alpha", true)
	ports := &sequencePorts{local: []int{43117, 43118, 43119, 43120}, public: []int{44419}}
	manager, processes, _, _ := newTestManagerWithPorts(t, ports)
	options := StartOptions{LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library}}
	first, err := manager.StartWithOptions(context.Background(), firstConsumer, "dev", options)
	if err != nil {
		t.Fatal(err)
	}
	tmux := manager.tmux.(*fakeTmux)
	observation := tmux.sessions[first.TmuxSession]
	if err := processes.StopGroup(observation.Process, time.Second); err != nil {
		t.Fatal(err)
	}
	tmux.mutex.Lock()
	delete(tmux.sessions, first.TmuxSession)
	tmux.mutex.Unlock()
	if _, err := manager.Status(context.Background(), firstConsumer, "dev"); err != nil {
		t.Fatal(err)
	}
	firstIdentity := mustTestIdentity(t, manager, firstConsumer, "dev")
	failed, found, err := manager.store.load(firstIdentity)
	if err != nil || !found || len(failed.Companions) != 0 || len(failed.Watchers) != 0 {
		t.Fatalf("cleaned failed state retained owners: found=%t state=%#v err=%v", found, failed, err)
	}

	second, err := manager.StartWithOptions(context.Background(), secondConsumer, "dev", options)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Companions) != 1 || !second.Companions[0].Created || !second.Companions[0].Owned {
		t.Fatalf("replacement companion = %#v", second.Companions)
	}
	companionIdentity := mustTestIdentity(t, manager, library, "prototype")
	companionState, found, err := manager.store.load(companionIdentity)
	if err != nil || !found {
		t.Fatalf("load replacement companion: found=%t err=%v", found, err)
	}
	companionProcess := ProcessRef{PID: companionState.PID, Identity: companionState.ProcessID}
	if _, err := manager.Stop(context.Background(), secondConsumer, "dev"); err != nil {
		t.Fatal(err)
	}
	if manager.processes.Alive(companionProcess) {
		t.Fatal("last consumer left its replacement companion running")
	}
}

func TestFailStartClearsStoppedCompanionBeforeNextConsumer(t *testing.T) {
	firstConsumer := writeTestScripts(t)
	secondConsumer := writeTestScripts(t)
	library := writeNodeLibraryFixture(t, "@example/alpha", true)
	ports := &sequencePorts{local: []int{43117, 43118, 43119, 43120}, public: []int{44419}}
	manager, _, _, _ := newTestManagerWithPorts(t, ports)
	options := StartOptions{LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library}}
	first, err := manager.StartWithOptions(context.Background(), firstConsumer, "dev", options)
	if err != nil {
		t.Fatal(err)
	}
	firstIdentity := mustTestIdentity(t, manager, firstConsumer, "dev")
	state, found, err := manager.store.load(firstIdentity)
	if err != nil || !found {
		t.Fatalf("load first consumer: found=%t err=%v", found, err)
	}
	failed, failErr := manager.failStart(state, errors.New("final state save failed"))
	if failErr == nil || failed.State != StateError || len(failed.Companions) != 0 || len(failed.Watchers) != 0 {
		t.Fatalf("failed cleanup result = %#v err=%v", failed, failErr)
	}
	persisted, found, err := manager.store.load(firstIdentity)
	if err != nil || !found || len(persisted.Companions) != 0 || len(persisted.Watchers) != 0 {
		t.Fatalf("failed state retained stopped owners: found=%t state=%#v err=%v", found, persisted, err)
	}

	second, err := manager.StartWithOptions(context.Background(), secondConsumer, "dev", options)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Companions) != 1 || !second.Companions[0].Created {
		t.Fatalf("next consumer did not create a fresh companion: first=%#v second=%#v", first.Companions, second.Companions)
	}
	if _, err := manager.Stop(context.Background(), secondConsumer, "dev"); err != nil {
		t.Fatal(err)
	}
}

func TestManagedServeStartsAndStopsBuiltPackageWatcher(t *testing.T) {
	consumer := writeTestScripts(t)
	library := writeWatchNodeLibraryFixture(t, true, false)
	go func() {
		time.Sleep(50 * time.Millisecond)
		_ = os.MkdirAll(filepath.Join(library, "dist"), 0o755)
		_ = os.WriteFile(filepath.Join(library, "dist/index.js"), []byte("export const built = true\n"), 0o644)
	}()
	manager, processes, _, _ := newTestManager(t)
	started, err := manager.StartWithOptions(context.Background(), consumer, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(started.Watchers) != 1 || started.Watchers[0].Package != "@example/built" {
		t.Fatalf("watchers = %#v", started.Watchers)
	}
	if got := processes.started[0].Argv; !reflect.DeepEqual(got, []string{"bun", "run", "watch"}) {
		t.Fatalf("watch command = %#v", got)
	}
	if _, err := manager.Stop(context.Background(), consumer, "dev"); err != nil {
		t.Fatal(err)
	}
	if len(processes.stopped) != 2 {
		t.Fatalf("stopped processes = %d", len(processes.stopped))
	}
}

func TestManagedServePortRaceRemovesPreviousWatcherGenerationArtifacts(t *testing.T) {
	consumer := writeTestScripts(t)
	library := writeWatchNodeLibraryFixture(t, true, true)
	ports := &sequencePorts{local: []int{43117, 43118}, public: []int{44419}}
	manager, processes, _, prober := newTestManagerWithPorts(t, ports)
	prober.waitErrorsByPort[43117] = []error{errors.New("foreign listener won the port race")}
	processes.foreignPorts[43117] = true

	started, err := manager.StartWithOptions(context.Background(), consumer, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifests, err := filepath.Glob(filepath.Join(manager.store.root, "libraries", started.ServerID+"-*.json"))
	if err != nil || len(manifests) != 1 {
		t.Fatalf("library manifests after retry = %#v err=%v", manifests, err)
	}
	if len(processes.started) != 4 || len(processes.stopped) != 2 {
		t.Fatalf("watcher retry lifecycle: started=%d stopped=%d", len(processes.started), len(processes.stopped))
	}
	if _, err := manager.Stop(context.Background(), consumer, "dev"); err != nil {
		t.Fatal(err)
	}
}

func TestManagedServeRetainsWatcherArtifactPathUntilDeletionSucceeds(t *testing.T) {
	consumer := writeTestScripts(t)
	library := writeWatchNodeLibraryFixture(t, true, true)
	manager, _, _, _ := newTestManager(t)
	started, err := manager.StartWithOptions(context.Background(), consumer, "dev", StartOptions{
		LocalOnly: true, APIs: APIsModeSimulated, Data: DataModeLocal, With: []string{library},
	})
	if err != nil {
		t.Fatal(err)
	}
	identity := mustTestIdentity(t, manager, consumer, "dev")
	state, found, err := manager.store.load(identity)
	if err != nil || !found || len(state.Watchers) != 1 {
		t.Fatalf("load watcher state: found=%t state=%#v err=%v", found, state, err)
	}
	logPath := state.Watchers[0].LogPath
	mustWriteTestFile(t, filepath.Join(logPath, "retained"), "keep")
	if _, err := manager.Stop(context.Background(), consumer, "dev"); err == nil {
		t.Fatal("stop unexpectedly removed a non-empty watcher log directory")
	}
	failed, found, err := manager.store.load(identity)
	if err != nil || !found {
		t.Fatalf("load artifact cleanup failure: found=%t err=%v", found, err)
	}
	if failed.PID != 0 || failed.ProcessID != "" || len(failed.Companions) != 0 ||
		len(failed.Watchers) != 1 || failed.Watchers[0].LogPath != logPath {
		t.Fatalf("artifact cleanup failure lost retry evidence: %#v", failed)
	}
	if err := os.RemoveAll(logPath); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Stop(context.Background(), consumer, "dev"); err != nil {
		t.Fatalf("retry artifact cleanup: %v", err)
	}
	if _, found, err := manager.store.load(identity); err != nil || found {
		t.Fatalf("clean retry left serve state: found=%t err=%v started=%#v", found, err, started)
	}
}

func TestDiscoverLocalNodeLibrariesRejectsBuiltPackageWithoutWatcher(t *testing.T) {
	library := writeWatchNodeLibraryFixture(t, false, true)
	_, err := discoverLocalNodeLibraries(context.Background(), t.TempDir(), []string{library})
	if err == nil || !strings.Contains(err.Error(), "declares no watch") {
		t.Fatalf("missing watcher error = %v", err)
	}
}

func TestLocalNodePackageKeepsMixedBuiltExportFailClosed(t *testing.T) {
	root := t.TempDir()
	mustWriteTestFile(t, filepath.Join(root, "src/index.ts"), "export const ui = true\n")
	mustWriteTestFile(t, filepath.Join(root, "dist/styles.css"), ".ui {}\n")
	pkg, include, err := localNodePackageFromManifest(root, nodePackageJSON{
		Name:    "@example/ui",
		Exports: map[string]any{".": "./dist/index.js", "./styles.css": "./dist/styles.css"},
	})
	if err != nil || !include || pkg.Mode != "source" {
		t.Fatalf("mixed package = %#v include=%v err=%v", pkg, include, err)
	}
	if len(pkg.Imports) != 1 || pkg.Imports[0].Specifier != "@example/ui" ||
		!reflect.DeepEqual(pkg.UnsupportedImports, []string{"@example/ui/styles.css"}) {
		t.Fatalf("mixed package mappings = %#v", pkg)
	}
}

func TestLocalNodePackageRejectsWildcardExports(t *testing.T) {
	_, _, err := localNodePackageFromManifest(t.TempDir(), nodePackageJSON{
		Name: "@example/ui", Exports: map[string]any{"./*": "./dist/*.js"},
	})
	if err == nil || !strings.Contains(err.Error(), "wildcard export") {
		t.Fatalf("wildcard error = %v", err)
	}
}

func writeNodeLibraryFixture(t *testing.T, firstPackageName string, companion bool) string {
	t.Helper()
	root := t.TempDir()
	mustWriteTestFile(t, filepath.Join(root, "package.json"), "{\n  \"name\": \"fixture-workspace\",\n  \"private\": true,\n  \"workspaces\": [\"packages/*\"]\n}\n")
	mustWriteTestFile(t, filepath.Join(root, "packages/alpha/package.json"), "{\n  \"name\": \""+firstPackageName+"\",\n  \"private\": true,\n  \"exports\": {\n    \".\": { \"types\": \"./dist/index.d.ts\", \"import\": \"./dist/index.js\" },\n    \"./feature\": { \"import\": \"./dist/feature.js\" }\n  }\n}\n")
	mustWriteTestFile(t, filepath.Join(root, "packages/alpha/src/index.ts"), "export const alpha = true\n")
	mustWriteTestFile(t, filepath.Join(root, "packages/alpha/src/feature.ts"), "export const feature = true\n")
	mustWriteTestFile(t, filepath.Join(root, "packages/beta/package.json"), "{\n  \"name\": \"@example/beta\",\n  \"private\": true,\n  \"exports\": { \".\": \"./src/index.ts\" }\n}\n")
	mustWriteTestFile(t, filepath.Join(root, "packages/beta/src/index.ts"), "export const beta = true\n")
	if companion {
		mustWriteTestFile(t, filepath.Join(root, scriptsConfigPath), "version: 2\nsetup:\n  - id: dependencies\n    command: [bun, install]\nservers:\n  prototype:\n    prototypeSurface: desktop-prototype\n    command: [test-server, --host, \"{host}\", --port, \"{port}\"]\n    healthCheck:\n      path: /health\n      timeoutSeconds: 2\n")
	}
	mustRunGit(t, root, "init", "-b", "main")
	mustRunGit(t, root, "add", ".")
	command := exec.Command("git", "-C", root, "-c", "user.name=Project Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, output)
	}
	return root
}

func writeWatchNodeLibraryFixture(t *testing.T, withWatcher, withOutput bool) string {
	t.Helper()
	root := t.TempDir()
	scripts := ""
	if withWatcher {
		scripts = ",\n  \"scripts\": { \"watch\": \"fixture-watch\" }"
	}
	mustWriteTestFile(t, filepath.Join(root, "package.json"), "{\n  \"name\": \"@example/built\",\n  \"exports\": { \".\": \"./dist/index.js\" }"+scripts+"\n}\n")
	if withOutput {
		mustWriteTestFile(t, filepath.Join(root, "dist/index.js"), "export const built = true\n")
	}
	mustRunGit(t, root, "init", "-b", "main")
	mustRunGit(t, root, "add", ".")
	command := exec.Command("git", "-C", root, "-c", "user.name=Project Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, output)
	}
	return root
}

func mustWriteTestFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustRunGit(t *testing.T, directory string, arguments ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, arguments...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(arguments, " "), err, output)
	}
}
