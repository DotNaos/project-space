package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DotNaos/project-space/internal/machineconnect"
)

func TestSourceConnectorResolvesIdentityOnlyWhenItsSupervisorRuns(t *testing.T) {
	root := sourceConnectorCheckoutFixture(t)
	profile, err := machineconnect.NewDevelopmentConnectorProfile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	resolveCalls := 0
	supervisor := &connectorSourceResolvingSupervisor{
		dependencies: connectorSourceCompanionDependencies{
			LookPath: func(string) (string, error) { return "/usr/bin/bun", nil },
			ResolveSourceState: func(context.Context, string) (connectorSourceState, error) {
				resolveCalls++
				return connectorSourceState{}, errors.New("inspect current source")
			},
		},
		profile: profile,
		root:    root,
	}
	if resolveCalls != 0 {
		t.Fatal("source identity was resolved before the connector started")
	}
	if err := supervisor.Run(context.Background()); err == nil || err.Error() != "source connector revision is invalid" {
		t.Fatalf("source supervisor error = %v", err)
	}
	if resolveCalls != 1 {
		t.Fatalf("source identity resolutions = %d, want 1 at start", resolveCalls)
	}
}

func sourceConnectorCheckoutFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "server"), 0o700); err != nil {
		t.Fatal(err)
	}
	for path, body := range map[string]string{
		filepath.Join(root, "package.json"):            "{}\n",
		filepath.Join(root, "server", "web-server.ts"): "console.log('source connector')\n",
	} {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestSourceConnectorLaunchUsesExplicitMetadataAndTrustedCheckout(t *testing.T) {
	root := sourceConnectorCheckoutFixture(t)
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	revision := strings.Repeat("a", 40)
	launch, err := resolveConnectorSourceLaunch(
		context.Background(),
		root,
		connectorSourceCompanionDependencies{
			LookPath: func(name string) (string, error) {
				if name != "bun" {
					t.Fatalf("looked up %q", name)
				}
				return "/home/oli/.bun/bin/bun", nil
			},
			ResolveSourceState: func(_ context.Context, actualRoot string) (connectorSourceState, error) {
				if actualRoot != canonicalRoot {
					t.Fatalf("revision root = %q, want %q", actualRoot, canonicalRoot)
				}
				return connectorSourceState{BuildID: revision, Revision: revision}, nil
			},
		},
	)
	if err != nil {
		t.Fatalf("resolve source connector launch: %v", err)
	}
	if launch.Executable != "/home/oli/.bun/bin/bun" || launch.Directory != canonicalRoot ||
		launch.BuildID != revision || launch.Revision != revision ||
		launch.ReleaseID != "dev-source-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatalf("source connector launch = %#v", launch)
	}
	for _, fixed := range []string{
		"PROJECT_SPACE_RELEASE_CHANNEL=dev",
		"PROJECT_SPACE_INSTALL_SOURCE=source",
		`exec "$bun" --no-env-file server/web-server.ts`,
	} {
		if !strings.Contains(connectorSourceLauncher, fixed) {
			t.Fatalf("source launcher is missing %q", fixed)
		}
	}
}

func TestSourceConnectorLaunchMarksDirtySourceWithoutClaimingHeadAsBuild(t *testing.T) {
	root := sourceConnectorCheckoutFixture(t)
	revision := strings.Repeat("a", 40)
	fingerprint := strings.Repeat("b", 40)
	launch, err := resolveConnectorSourceLaunch(
		context.Background(),
		root,
		connectorSourceCompanionDependencies{
			LookPath: func(string) (string, error) { return "/usr/bin/bun", nil },
			ResolveSourceState: func(context.Context, string) (connectorSourceState, error) {
				return connectorSourceState{BuildID: fingerprint, Dirty: true, Revision: revision}, nil
			},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if launch.BuildID != fingerprint || launch.ReleaseID != "dev-source-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-dirty" {
		t.Fatalf("dirty source identity = %#v", launch)
	}
}

func TestSourceConnectorStateRequiresGitRootAndFingerprintsDirtyContent(t *testing.T) {
	root := sourceConnectorCheckoutFixture(t)
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, arguments := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "connector-test@example.test"},
		{"config", "user.name", "Connector Test"},
		{"add", "package.json", "server/web-server.ts"},
		{"commit", "-qm", "source fixture"},
	} {
		command := exec.Command("git", append([]string{"-C", root}, arguments...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", arguments, err, output)
		}
	}
	clean, err := resolveConnectorSourceState(context.Background(), canonicalRoot)
	if err != nil {
		t.Fatal(err)
	}
	if clean.Dirty || clean.BuildID != clean.Revision {
		t.Fatalf("clean source state = %#v", clean)
	}
	if err := os.WriteFile(
		filepath.Join(root, "server", "web-server.ts"),
		[]byte("console.log('changed source connector')\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	dirty, err := resolveConnectorSourceState(context.Background(), canonicalRoot)
	if err != nil {
		t.Fatal(err)
	}
	if !dirty.Dirty || dirty.Revision != clean.Revision || dirty.BuildID == dirty.Revision {
		t.Fatalf("dirty source state = %#v", dirty)
	}
	if _, err := resolveConnectorSourceState(
		context.Background(), filepath.Join(canonicalRoot, "server"),
	); err == nil {
		t.Fatal("source connector accepted a nested directory instead of the Git root")
	}
}

func TestSourceConnectorLaunchRejectsUntrustedCheckoutAndRevision(t *testing.T) {
	validRoot := sourceConnectorCheckoutFixture(t)
	missingEntry := t.TempDir()
	if err := os.WriteFile(filepath.Join(missingEntry, "package.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlinkRoot := sourceConnectorCheckoutFixture(t)
	realEntry := filepath.Join(symlinkRoot, "server", "real.ts")
	if err := os.WriteFile(realEntry, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(symlinkRoot, "server", "web-server.ts")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realEntry, filepath.Join(symlinkRoot, "server", "web-server.ts")); err != nil {
		t.Skipf("create source entry symlink: %v", err)
	}

	for name, root := range map[string]string{
		"missing entry": missingEntry,
		"symlink entry": symlinkRoot,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := resolveConnectorSourceLaunch(
				context.Background(), root, sourceCompanionTestDependencies(strings.Repeat("a", 40)),
			)
			if err == nil {
				t.Fatal("untrusted source checkout was accepted")
			}
		})
	}
	if _, err := resolveConnectorSourceLaunch(
		context.Background(), validRoot, sourceCompanionTestDependencies("main"),
	); err == nil {
		t.Fatal("mutable source revision was accepted")
	}
}

func sourceCompanionTestDependencies(revision string) connectorSourceCompanionDependencies {
	return connectorSourceCompanionDependencies{
		LookPath: func(string) (string, error) { return "/usr/bin/bun", nil },
		ResolveSourceState: func(context.Context, string) (connectorSourceState, error) {
			return connectorSourceState{BuildID: revision, Revision: revision}, nil
		},
	}
}
