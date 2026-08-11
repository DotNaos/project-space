package projectrun

import (
	"path/filepath"
	"testing"
)

func TestServerIdentityUsesRepositoryWorktreeAndServerKey(t *testing.T) {
	repository := filepath.Join(string(filepath.Separator), "repos", "project-space", ".git")
	first := newServerIdentity(repository, "/worktrees/one", "dev")
	again := newServerIdentity(repository, "/worktrees/one", "dev")
	otherWorktree := newServerIdentity(repository, "/worktrees/two", "dev")
	otherServer := newServerIdentity(repository, "/worktrees/one", "docs")

	if first != again {
		t.Fatalf("identity is not deterministic: %#v != %#v", first, again)
	}
	if first.ServerID == otherWorktree.ServerID || first.ServerID == otherServer.ServerID {
		t.Fatalf("distinct managed instances collided: %#v %#v %#v", first, otherWorktree, otherServer)
	}
	if first.ServerID != first.TmuxSession || first.ServerKey != "dev" {
		t.Fatalf("identity fields = %#v", first)
	}
}

func TestServerIdentityDoesNotDependOnBranchName(t *testing.T) {
	identity := newServerIdentity("/repos/project-space/.git", "/worktrees/renamed", "dev")
	if identity.ServerID != "project-serve-project-space-dev-"+identity.ServerID[len(identity.ServerID)-12:] {
		t.Fatalf("unexpected readable identity %q", identity.ServerID)
	}
}
