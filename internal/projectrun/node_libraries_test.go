package projectrun

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
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

func TestManagedServeStartsAndStopsBuiltPackageWatcher(t *testing.T) {
	consumer := writeTestScripts(t)
	library := writeWatchNodeLibraryFixture(t, true)
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
	if got := processes.started[1].Argv; !reflect.DeepEqual(got, []string{"bun", "run", "watch"}) {
		t.Fatalf("watch command = %#v", got)
	}
	if _, err := manager.Stop(context.Background(), consumer, "dev"); err != nil {
		t.Fatal(err)
	}
	if len(processes.stopped) != 2 {
		t.Fatalf("stopped processes = %d", len(processes.stopped))
	}
}

func TestDiscoverLocalNodeLibrariesRejectsBuiltPackageWithoutWatcher(t *testing.T) {
	library := writeWatchNodeLibraryFixture(t, false)
	_, err := discoverLocalNodeLibraries(context.Background(), t.TempDir(), []string{library})
	if err == nil || !strings.Contains(err.Error(), "declares no watch") {
		t.Fatalf("missing watcher error = %v", err)
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

func writeWatchNodeLibraryFixture(t *testing.T, withWatcher bool) string {
	t.Helper()
	root := t.TempDir()
	scripts := ""
	if withWatcher {
		scripts = ",\n  \"scripts\": { \"watch\": \"fixture-watch\" }"
	}
	mustWriteTestFile(t, filepath.Join(root, "package.json"), "{\n  \"name\": \"@example/built\",\n  \"exports\": { \".\": \"./dist/index.js\" }"+scripts+"\n}\n")
	mustWriteTestFile(t, filepath.Join(root, "dist/index.js"), "export const built = true\n")
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
