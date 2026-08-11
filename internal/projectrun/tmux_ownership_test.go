package projectrun

import "testing"

func TestTmuxOwnershipIncludesRuntimeBindings(t *testing.T) {
	base := TmuxSessionSpec{
		Name: "project", ServerID: "server", RepositoryPath: "/repo", WorktreePath: "/repo/worktree",
		ServerKey: "dev", Generation: "generation", OwnershipToken: "token", Mode: ServeModeManaged,
		APIs: APIsModeSimulated, Data: DataModeLocal, LocalPort: 4100, PublicPort: 443,
	}

	differentAPIs := base
	differentAPIs.APIs = APIsModeExternal
	if sameTmuxOwnership(base, differentAPIs) {
		t.Fatal("API binding changes must invalidate tmux ownership")
	}
	differentData := base
	differentData.Data = DataModeRemote
	if sameTmuxOwnership(base, differentData) {
		t.Fatal("data binding changes must invalidate tmux ownership")
	}
}

func TestLegacyTmuxBindingsAreExternalRemote(t *testing.T) {
	apis, data := normalizeTmuxBindings("", "")
	if apis != APIsModeExternal || data != DataModeRemote {
		t.Fatalf("legacy binding = %s/%s, want external/remote", apis, data)
	}
}
