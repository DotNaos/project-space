package worktreeownership

import "testing"

func TestInspectContextClassifiesSharedMainAsProjectManager(t *testing.T) {
	mainPath := setupRepository(t)
	context, err := InspectContext(mainPath, firstThread)
	if err != nil {
		t.Fatal(err)
	}
	if context.State != "main" || context.Role != "project-manager" || context.MutatingAllowed {
		t.Fatalf("unexpected main context: %#v", context)
	}
}

func TestInspectContextClassifiesOwnedManagedWorktreeAsImplementer(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "issue-819-owned")
	if _, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread}); err != nil {
		t.Fatal(err)
	}

	context, err := InspectContext(worktreePath, firstThread)
	if err != nil {
		t.Fatal(err)
	}
	if context.State != "owned" || context.Role != "implementer" || !context.MutatingAllowed || context.OwnerThreadID != firstThread {
		t.Fatalf("unexpected owned context: %#v", context)
	}
}

func TestInspectContextClassifiesForeignWorktreeWithoutMutation(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "issue-819-foreign")
	if _, err := Claim(ClaimOptions{StartPath: worktreePath, ThreadID: firstThread}); err != nil {
		t.Fatal(err)
	}

	context, err := InspectContext(worktreePath, secondThread)
	if err != nil {
		t.Fatal(err)
	}
	if context.State != "foreign" || context.MutatingAllowed || context.OwnerThreadID != firstThread {
		t.Fatalf("unexpected foreign context: %#v", context)
	}
}

func TestInspectContextClassifiesUnmanagedWorktreeWithoutMutation(t *testing.T) {
	mainPath := setupRepository(t)
	worktreePath := addStandardWorktree(t, mainPath, "issue-819-unmanaged")

	context, err := InspectContext(worktreePath, firstThread)
	if err != nil {
		t.Fatal(err)
	}
	if context.State != "unmanaged" || context.MutatingAllowed || context.Managed {
		t.Fatalf("unexpected unmanaged context: %#v", context)
	}
}
