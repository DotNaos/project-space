package workspacerun

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWorkspaceRuntimeLockRefusesSymlinkWithoutChangingForeignFile(t *testing.T) {
	store, err := newStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(t.TempDir(), "foreign")
	if err := os.WriteFile(foreign, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	workspaceID := "ws_0123456789abcdef01234567"
	if err := os.Symlink(foreign, filepath.Join(store.root, "locks", workspaceID+".lock")); err != nil {
		t.Fatal(err)
	}
	if err := store.withLock(workspaceID, func() error { t.Fatal("action ran"); return nil }); err == nil {
		t.Fatal("symlink lock was accepted")
	}
	body, err := os.ReadFile(foreign)
	info, statErr := os.Stat(foreign)
	if err != nil || statErr != nil || string(body) != "keep" || info.Mode().Perm() != 0o644 {
		t.Fatalf("foreign file changed: body=%q mode=%v readErr=%v statErr=%v", body, info.Mode().Perm(), err, statErr)
	}
}

func TestRemoveGenerationRefusesSymlinkTarget(t *testing.T) {
	store, err := newStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspaceID := "ws_0123456789abcdef01234567"
	generation := "11111111-1111-4111-8111-111111111111"
	parent := filepath.Join(store.root, "generations", workspaceID)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	foreign := t.TempDir()
	marker := filepath.Join(foreign, "keep")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(foreign, filepath.Join(parent, generation)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.removeGeneration(workspaceID, generation, "1:1"); err == nil {
		t.Fatal("symlink generation was accepted")
	}
	if body, err := os.ReadFile(marker); err != nil || string(body) != "keep" {
		t.Fatalf("foreign generation changed: body=%q err=%v", body, err)
	}
}

func TestStateStoreRefusesReplacedNamespaceDirectories(t *testing.T) {
	store, err := newStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"states", "generations"} {
		original := filepath.Join(store.root, name)
		moved := original + ".original"
		if err := os.Rename(original, moved); err != nil {
			t.Fatal(err)
		}
		foreign := t.TempDir()
		marker := filepath.Join(foreign, "keep")
		if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(foreign, original); err != nil {
			t.Fatal(err)
		}
		switch name {
		case "states":
			_, _, err = store.load(WorkspaceIdentity{WorkspaceID: "ws_0123456789abcdef01234567"})
		case "generations":
			_, err = store.prepareGeneration("ws_0123456789abcdef01234567", "11111111-1111-4111-8111-111111111111")
		}
		if err == nil {
			t.Fatalf("replaced %s directory was accepted", name)
		}
		if body, readErr := os.ReadFile(marker); readErr != nil || string(body) != "keep" {
			t.Fatalf("foreign %s directory changed: body=%q err=%v", name, body, readErr)
		}
		if err := os.Remove(original); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(moved, original); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStateStoreRefusesPreexistingHardlinkedLogWithoutTruncatingIt(t *testing.T) {
	store, err := newStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspaceID := "ws_0123456789abcdef01234567"
	generation := "11111111-1111-4111-8111-111111111111"
	proof, err := store.prepareGeneration(workspaceID, generation)
	if err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(t.TempDir(), "foreign.log")
	if err := os.WriteFile(foreign, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(foreign, store.logPath(workspaceID, generation)); err != nil {
		t.Fatal(err)
	}
	if file, err := store.openLog(runtimeRecord{WorkspaceID: workspaceID, Generation: generation, GenerationProof: proof}); err == nil {
		_ = file.Close()
		t.Fatal("preexisting hardlinked log was accepted")
	}
	if body, err := os.ReadFile(foreign); err != nil || string(body) != "keep" {
		t.Fatalf("foreign log changed: body=%q err=%v", body, err)
	}
}

func TestRemoveGenerationRefusesReplacedPrivateDirectory(t *testing.T) {
	store, err := newStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspaceID := "ws_0123456789abcdef01234567"
	generation := "11111111-1111-4111-8111-111111111111"
	proof, err := store.prepareGeneration(workspaceID, generation)
	if err != nil {
		t.Fatal(err)
	}
	path := store.generationHome(workspaceID, generation)
	if err := os.Rename(path, path+".owned"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(path, "keep")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.removeGeneration(workspaceID, generation, proof); err == nil {
		t.Fatal("replaced generation directory was accepted")
	}
	if body, err := os.ReadFile(marker); err != nil || string(body) != "keep" {
		t.Fatalf("replacement directory changed: body=%q err=%v", body, err)
	}
}

func TestRemoveGenerationDoesNotConfirmReplacementAtRenameCutpoint(t *testing.T) {
	store, err := newStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspaceID := "ws_0123456789abcdef01234567"
	generation := "11111111-1111-4111-8111-111111111111"
	proof, err := store.prepareGeneration(workspaceID, generation)
	if err != nil {
		t.Fatal(err)
	}
	path := store.generationHome(workspaceID, generation)
	ownedMoved := path + ".owned"
	store.beforeGenerationQuarantine = func() error {
		if err := os.Rename(path, ownedMoved); err != nil {
			return err
		}
		return os.Mkdir(path, 0o700)
	}
	if archive, err := store.removeGeneration(workspaceID, generation, proof); err == nil || archive != "" {
		t.Fatalf("rename-cutpoint replacement was confirmed: archive=%q err=%v", archive, err)
	}
	if info, err := os.Stat(ownedMoved); err != nil || !info.IsDir() {
		t.Fatalf("owned generation was changed: info=%v err=%v", info, err)
	}
}

func TestStateSaveRefusesReplacedRegularFileWithoutChangingForeignContent(t *testing.T) {
	store, err := newStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	identity := lifecycleWorkspaceIdentity(t.TempDir())
	proof, err := store.prepareGeneration(identity.WorkspaceID, "11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatal(err)
	}
	record := runtimeRecord{
		Version: SchemaVersion, WorkspaceID: identity.WorkspaceID, Repository: identity.Repository,
		Directory: identity.Directory, GitDirectory: identity.GitDirectory, Branch: identity.Branch,
		Head: identity.Head, IdentityProof: identity.IdentityProof, ManifestDigest: strings.Repeat("c", 64),
		Mode: ModeProcess, State: StateStarting, Generation: "11111111-1111-4111-8111-111111111111",
		GenerationProof: proof, OwnershipToken: "22222222-2222-4222-8222-222222222222",
		DevServers: []ManagedDevServer{}, CheckedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err := store.save(record); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.load(identity); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(t.TempDir(), "foreign.json")
	if err := os.WriteFile(foreign, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(store.statePath(identity.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(foreign, store.statePath(identity.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	record.LastError = "should not publish"
	if err := store.save(record); err == nil {
		t.Fatal("replaced state file was overwritten")
	}
	if body, err := os.ReadFile(foreign); err != nil || string(body) != "keep" {
		t.Fatalf("foreign state changed: body=%q err=%v", body, err)
	}
}

func TestRemoveGenerationResumesAfterCrashAtQuarantineCutpoint(t *testing.T) {
	store, err := newStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspaceID := "ws_0123456789abcdef01234567"
	generation := "11111111-1111-4111-8111-111111111111"
	proof, err := store.prepareGeneration(workspaceID, generation)
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(store.generationHome(workspaceID, generation), "owned")
	if err := os.WriteFile(marker, []byte("owned"), 0o600); err != nil {
		t.Fatal(err)
	}
	store.afterGenerationQuarantine = func() error { return errors.New("fixture crash after quarantine") }
	if _, err := store.removeGeneration(workspaceID, generation, proof); err == nil {
		t.Fatal("quarantine cutpoint did not interrupt cleanup")
	}
	store.afterGenerationQuarantine = nil
	archive, err := store.removeGeneration(workspaceID, generation, proof)
	if err != nil {
		t.Fatalf("resume quarantined cleanup: %v", err)
	}
	if !strings.HasPrefix(archive, ".retained-"+generation+"-") {
		t.Fatalf("unexpected retained generation name %q", archive)
	}
	root, err := store.openDirectory("generations")
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if name, err := directoryContainsProof(root, proof, ".retained-"+generation+"-"); err != nil || name != archive {
		t.Fatalf("proof-bound retained generation mismatch: name=%q archive=%q err=%v", name, archive, err)
	}
}
