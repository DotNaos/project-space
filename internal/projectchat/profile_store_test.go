package projectchat

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestFileAgentProfileStoreKeepsNamesSeparateByThread(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profiles.json")
	store := &FileAgentProfileStore{Path: path}
	firstThread := "019f49e1-cc3d-7243-bc12-75c74c786457"
	secondThread := "019f503f-f91d-72e3-a8fb-86f167209b9f"

	if err := store.Save(firstThread, AgentProfile{DisplayName: "Nora", TaskTitle: "Live chat"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(secondThread, AgentProfile{DisplayName: "Mira"}); err != nil {
		t.Fatal(err)
	}
	first, err := store.Load(firstThread)
	if err != nil || first.DisplayName != "Nora" || first.TaskTitle != "Live chat" {
		t.Fatalf("first profile = %#v, %v", first, err)
	}
	second, err := store.Load(secondThread)
	if err != nil || second.DisplayName != "Mira" {
		t.Fatalf("second profile = %#v, %v", second, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("profile file mode = %v, %v", info.Mode().Perm(), err)
	}
}

func TestFileAgentProfileStoreRejectsGenericCodexName(t *testing.T) {
	store := &FileAgentProfileStore{Path: filepath.Join(t.TempDir(), "profiles.json")}
	err := store.Save("019f49e1-cc3d-7243-bc12-75c74c786457", AgentProfile{DisplayName: "codex"})
	if !errors.Is(err, ErrInvalidAgentName) {
		t.Fatalf("Save() error = %v, want invalid agent name", err)
	}
}
