package workspacerun

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolvedPlanDigestBindsHeadScriptsManifestAndDeclaredInputs(t *testing.T) {
	directory := t.TempDir()
	writeRuntimeFixture(t, directory, ModeProcess)
	inputPath := filepath.Join(directory, "toolchain.lock")
	if err := os.WriteFile(inputPath, []byte("toolchain=v1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, manifestPath)
	manifest, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest = []byte(strings.Replace(string(manifest), "inputs: []", "inputs:\n  - toolchain.lock", 1))
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	identity := lifecycleWorkspaceIdentity(directory)
	baseline, err := resolvePlan(context.Background(), lifecycleIdentityResolver{identity: identity}, directory, ModeProcess)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(inputPath, []byte("toolchain=v2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	inputChanged, err := resolvePlan(context.Background(), lifecycleIdentityResolver{identity: identity}, directory, ModeProcess)
	if err != nil {
		t.Fatal(err)
	}
	assertRuntimeDigestChanged(t, baseline.Digest, inputChanged.Digest, "declared input")

	scriptsPath := filepath.Join(directory, ".project", "scripts.yaml")
	scripts, err := os.ReadFile(scriptsPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(scriptsPath, append(scripts, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	scriptsChanged, err := resolvePlan(context.Background(), lifecycleIdentityResolver{identity: identity}, directory, ModeProcess)
	if err != nil {
		t.Fatal(err)
	}
	assertRuntimeDigestChanged(t, inputChanged.Digest, scriptsChanged.Digest, "scripts declaration")

	manifest, err = os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, append(manifest, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	manifestChanged, err := resolvePlan(context.Background(), lifecycleIdentityResolver{identity: identity}, directory, ModeProcess)
	if err != nil {
		t.Fatal(err)
	}
	assertRuntimeDigestChanged(t, scriptsChanged.Digest, manifestChanged.Digest, "manifest bytes")

	identity.Head = strings.Repeat("c", 40)
	headChanged, err := resolvePlan(context.Background(), lifecycleIdentityResolver{identity: identity}, directory, ModeProcess)
	if err != nil {
		t.Fatal(err)
	}
	assertRuntimeDigestChanged(t, manifestChanged.Digest, headChanged.Digest, "source HEAD")
}

func assertRuntimeDigestChanged(t *testing.T, before, after, source string) {
	t.Helper()
	if before == after || !sha256Pattern.MatchString(after) {
		t.Fatalf("%s digest did not change: before=%q after=%q", source, before, after)
	}
}
