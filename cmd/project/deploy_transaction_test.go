package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

const (
	testRequestedCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testPreviousCommit  = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func TestResolveExactDeployCommitUsesCurrentMain(t *testing.T) {
	original := resolveDeployRemoteHead
	resolveDeployRemoteHead = func(string, string) (string, error) { return testRequestedCommit, nil }
	t.Cleanup(func() { resolveDeployRemoteHead = original })

	requested, current, err := resolveExactDeployCommit(t.TempDir(), "main", testRequestedCommit)
	if err != nil {
		t.Fatal(err)
	}
	if requested != testRequestedCommit || current != testRequestedCommit {
		t.Fatalf("requested/current = %s/%s", requested, current)
	}
}

func TestResolveExactDeployCommitRejectsMalformedAndSupersededCommits(t *testing.T) {
	original := resolveDeployRemoteHead
	resolveDeployRemoteHead = func(string, string) (string, error) { return testRequestedCommit, nil }
	t.Cleanup(func() { resolveDeployRemoteHead = original })

	if _, _, err := resolveExactDeployCommit(t.TempDir(), "main", "abc123"); err == nil || !strings.Contains(err.Error(), "full 40-character") {
		t.Fatalf("short SHA error = %v", err)
	}
	_, _, err := resolveExactDeployCommit(t.TempDir(), "main", testPreviousCommit)
	stateErr, ok := err.(deployStateError)
	if !ok || stateErr.State != "superseded" {
		t.Fatalf("stale SHA error = %#v", err)
	}
}

func TestFailedPreDeployValidationNeverStartsRemoteTransaction(t *testing.T) {
	originalHead := resolveDeployRemoteHead
	originalExecute := executeDeployRemoteTransaction
	resolveDeployRemoteHead = func(string, string) (string, error) { return testRequestedCommit, nil }
	remoteCalled := false
	executeDeployRemoteTransaction = func(string, string) (string, error) {
		remoteCalled = true
		return "", nil
	}
	t.Cleanup(func() {
		resolveDeployRemoteHead = originalHead
		executeDeployRemoteTransaction = originalExecute
	})

	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	projectRoot := filepath.Clean(filepath.Join(workingDirectory, "..", ".."))
	_, err = deployProjectToVPS(&cobra.Command{}, projectRoot, deployOptions{
		Environment: deployProdEnvironment,
		Commit:      "not-a-full-sha",
		LockTimeout: time.Second,
	})
	if err == nil {
		t.Fatal("expected pre-deployment validation failure")
	}
	if remoteCalled {
		t.Fatal("remote transaction started after validation failed")
	}
}

func TestParseDeployEventsKeepsRollbackEvidence(t *testing.T) {
	project := deployProject{Evidence: &deployEvidence{RequestedCommit: testRequestedCommit}}
	parseDeployEvents(&project, strings.Join([]string{
		deployEventPrefix + "phase|deploy|failed",
		deployEventPrefix + "rollback|status|rollback_succeeded",
		deployEventPrefix + "rollback|commit|" + testPreviousCommit,
		deployEventPrefix + "rollback|verifiedCommit|" + testPreviousCommit,
		deployEventPrefix + "state|rollback_succeeded|deployment failed",
	}, "\n"))
	if project.Status != "rollback_succeeded" || project.Rollback == nil {
		t.Fatalf("parsed project = %#v", project)
	}
	if project.Rollback.VerifiedCommit != testPreviousCommit {
		t.Fatalf("rollback evidence = %#v", project.Rollback)
	}
}

func TestDeployTransactionLockCollisionMutatesNothing(t *testing.T) {
	root := t.TempDir()
	fakeBin := filepath.Join(root, "bin")
	mustWriteExecutable(t, filepath.Join(fakeBin, "sudo"), "#!/bin/sh\n[ \"$1\" = -n ] && shift\nexec \"$@\"\n")
	mustWriteExecutable(t, filepath.Join(fakeBin, "flock"), "#!/bin/sh\nexit 1\n")
	gitMarker := filepath.Join(root, "git-called")
	mustWriteExecutable(t, filepath.Join(fakeBin, "git"), "#!/bin/sh\ntouch \"$GIT_MARKER\"\nexit 1\n")

	project, options, script := deployScriptFixture(root)
	_ = project
	command := exec.Command("sh", "-s")
	command.Stdin = strings.NewReader(script)
	command.Env = append(os.Environ(), "PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"), "GIT_MARKER="+gitMarker)
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatal("expected lock collision")
	}
	if !strings.Contains(string(output), deployEventPrefix+"state|blocked|") {
		t.Fatalf("lock output:\n%s", output)
	}
	if _, statErr := os.Stat(gitMarker); !os.IsNotExist(statErr) {
		t.Fatalf("git ran despite lock collision: %v", statErr)
	}
	if options.LockTimeout != time.Second {
		t.Fatalf("fixture lock timeout = %s", options.LockTimeout)
	}
}

func TestDeployTransactionRechecksMainUnderLockBeforeMutation(t *testing.T) {
	root := t.TempDir()
	fakeBin := filepath.Join(root, "bin")
	remotePath := filepath.Join(root, "remote")
	if err := os.MkdirAll(filepath.Join(remotePath, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWriteExecutable(t, filepath.Join(fakeBin, "sudo"), "#!/bin/sh\n[ \"$1\" = -n ] && shift\nexec \"$@\"\n")
	mustWriteExecutable(t, filepath.Join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n")
	mustWriteExecutable(t, filepath.Join(fakeBin, "git"), "#!/bin/sh\nif [ \"$1\" = rev-parse ]; then echo \"$NEW_MAIN\"; fi\nexit 0\n")
	dockerMarker := filepath.Join(root, "docker-called")
	mustWriteExecutable(t, filepath.Join(fakeBin, "docker"), "#!/bin/sh\ntouch \"$DOCKER_MARKER\"\nexit 1\n")

	project := deployProject{
		Name: "project-space", Environment: "prod", RemoteURL: "https://example.invalid/repo.git",
		RemotePath: remotePath, Branch: "main", ComposeProject: "project-space-prod",
		WebURL: "https://projects.example", BuildCommit: testRequestedCommit, BuildRef: "refs/heads/main",
	}
	options := deployOptions{LockTimeout: time.Second, ProjectDomain: "projects.example", APIDomain: "api.projects.example"}
	script := deployTransactionScriptForPaths(project, options, filepath.Join(root, "deploy.lock"), filepath.Join(root, "state"))
	command := exec.Command("sh", "-s")
	command.Stdin = strings.NewReader(script)
	command.Env = append(os.Environ(),
		"PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"NEW_MAIN="+testPreviousCommit,
		"DOCKER_MARKER="+dockerMarker,
	)
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), deployEventPrefix+"state|superseded|") {
		t.Fatalf("stale-under-lock output/error: %v\n%s", err, output)
	}
	if _, statErr := os.Stat(dockerMarker); !os.IsNotExist(statErr) {
		t.Fatalf("docker ran after the under-lock stale check: %v", statErr)
	}
}

func TestDeployFailureRollsBackAndVerifiesPreviousCommit(t *testing.T) {
	output, err, stateRoot, stateDir, _ := runDeployScenario(t, "compose")
	if err == nil {
		t.Fatal("expected failed deployment after successful rollback")
	}
	assertRollbackRestoredPrevious(t, output, stateRoot, stateDir)
}

func TestFirstLegacyRollbackKeepsCompatibilityForRetry(t *testing.T) {
	output, err, _, stateDir, rerun := runDeployScenario(t, "legacy-compose")
	if err == nil || !bytes.Contains(output, []byte(deployEventPrefix+"rollback|status|rollback_succeeded")) {
		t.Fatalf("legacy rollback result: %v\n%s", err, output)
	}
	compatibility, readErr := os.ReadFile(filepath.Join(stateDir, "compat", testPreviousCommit))
	if readErr != nil || strings.TrimSpace(string(compatibility)) != "compat" {
		t.Fatalf("legacy compatibility state = %q, %v", compatibility, readErr)
	}
	_, _, script := deployScriptFixture(t.TempDir())
	if !strings.Contains(script, `previous_strict=false`) || !strings.Contains(script, `"$compatibility_dir/$previous"`) {
		t.Fatal("retry path does not restore legacy compatibility mode")
	}
	retryOutput, retryErr := rerun("compose")
	if retryErr == nil || !bytes.Contains(retryOutput, []byte(deployEventPrefix+"rollback|status|rollback_succeeded")) {
		t.Fatalf("legacy retry did not remain rollback-compatible: %v\n%s", retryErr, retryOutput)
	}
}

func TestDeployHealthFailureRollsBackAndVerifiesPreviousCommit(t *testing.T) {
	output, err, stateRoot, stateDir, _ := runDeployScenario(t, "health")
	if err == nil {
		t.Fatal("expected failed health verification after successful rollback")
	}
	assertRollbackRestoredPrevious(t, output, stateRoot, stateDir)
}

func TestInterruptedDeployRollsBackAndVerifiesPreviousCommit(t *testing.T) {
	output, err, stateRoot, stateDir, _ := runDeployScenario(t, "interrupt")
	if err == nil {
		t.Fatal("expected interrupted deployment to return a failure")
	}
	assertRollbackRestoredPrevious(t, output, stateRoot, stateDir)
}

func TestDeploySuccessPersistsExactRequestedCommit(t *testing.T) {
	output, err, stateRoot, stateDir, _ := runDeployScenario(t, "")
	if err != nil {
		t.Fatalf("successful deployment: %v\n%s", err, output)
	}
	if !bytes.Contains(output, []byte(deployEventPrefix+"state|success|")) {
		t.Fatalf("success output:\n%s", output)
	}
	for _, path := range []string{filepath.Join(stateRoot, "checkout"), filepath.Join(stateRoot, "runtime"), filepath.Join(stateDir, "verified.sha")} {
		value, readErr := os.ReadFile(path)
		if readErr != nil || strings.TrimSpace(string(value)) != testRequestedCommit {
			t.Fatalf("exact commit at %s = %q, %v", path, value, readErr)
		}
	}
}

func TestDeployRetriesTransientPublicIngressFailure(t *testing.T) {
	output, err, stateRoot, stateDir, _ := runDeployScenario(t, "transient")
	if err != nil {
		t.Fatalf("transient public verification: %v\n%s", err, output)
	}
	for _, path := range []string{filepath.Join(stateRoot, "checkout"), filepath.Join(stateRoot, "runtime"), filepath.Join(stateDir, "verified.sha")} {
		value, readErr := os.ReadFile(path)
		if readErr != nil || strings.TrimSpace(string(value)) != testRequestedCommit {
			t.Fatalf("exact commit after transient ingress at %s = %q, %v", path, value, readErr)
		}
	}
}

func TestDeployPublicRetryWindowIsBounded(t *testing.T) {
	_, _, script := deployScriptFixture(t.TempDir())
	if !strings.Contains(script, `public_attempt" -le 10`) || !strings.Contains(script, `--max-time 2`) || !strings.Contains(script, `sleep 2`) {
		t.Fatalf("public retry window is not bounded:\n%s", script)
	}
}

func TestDeployScriptCleansBuildInputsButPreservesRuntimeSSH(t *testing.T) {
	_, _, script := deployScriptFixture(t.TempDir())
	if !strings.Contains(script, "git clean -fdx -e ssh/") {
		t.Fatalf("deploy script does not preserve ssh while cleaning:\n%s", script)
	}
}

func runDeployScenario(t *testing.T, failureMode string) ([]byte, error, string, string, func(string) ([]byte, error)) {
	t.Helper()
	root := t.TempDir()
	fakeBin := filepath.Join(root, "bin")
	stateRoot := filepath.Join(root, "fake-state")
	remotePath := filepath.Join(root, "remote")
	stateDir := filepath.Join(root, "deployment-state")
	if err := os.MkdirAll(filepath.Join(remotePath, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stateRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if failureMode != "legacy-compose" {
		mustWriteDeployTestFile(t, filepath.Join(stateDir, "verified.sha"), testPreviousCommit+"\n")
	}
	mustWriteDeployTestFile(t, filepath.Join(stateRoot, "checkout"), testPreviousCommit+"\n")
	mustWriteDeployTestFile(t, filepath.Join(stateRoot, "runtime"), testPreviousCommit+"\n")

	mustWriteExecutable(t, filepath.Join(fakeBin, "sudo"), "#!/bin/sh\n[ \"$1\" = -n ] && shift\nexec \"$@\"\n")
	mustWriteExecutable(t, filepath.Join(fakeBin, "flock"), "#!/bin/sh\nexit 0\n")
	mustWriteExecutable(t, filepath.Join(fakeBin, "git"), fakeGitScript)
	mustWriteExecutable(t, filepath.Join(fakeBin, "docker"), fakeDockerScript)
	mustWriteExecutable(t, filepath.Join(fakeBin, "curl"), fakeCurlScript)
	mustWriteExecutable(t, filepath.Join(fakeBin, "sleep"), "#!/bin/sh\nexit 0\n")

	project := deployProject{
		Name: "project-space", Environment: "prod", RemoteURL: "https://example.invalid/repo.git",
		RemotePath: remotePath, Branch: "main", ComposeProject: "project-space-prod",
		WebURL: "https://projects.example", BuildCommit: testRequestedCommit, BuildRef: "refs/heads/main",
	}
	options := deployOptions{LockTimeout: time.Second, ProjectDomain: "projects.example", APIDomain: "api.projects.example"}
	script := deployTransactionScriptForPaths(project, options, filepath.Join(root, "deploy.lock"), stateDir)
	legacyImage := strings.HasPrefix(failureMode, "legacy-")
	run := func(mode string) ([]byte, error) {
		command := exec.Command("sh", "-s")
		command.Stdin = strings.NewReader(script)
		command.Env = append(os.Environ(),
			"PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"),
			"FAKE_STATE="+stateRoot,
			"REMOTE_PATH="+remotePath,
			"REQUESTED_COMMIT="+testRequestedCommit,
			"PREVIOUS_COMMIT="+testPreviousCommit,
			"DEPLOY_FAILURE_MODE="+mode,
			"LEGACY_IMAGE="+strconv.FormatBool(legacyImage),
		)
		return command.CombinedOutput()
	}
	output, err := run(strings.TrimPrefix(failureMode, "legacy-"))
	return output, err, stateRoot, stateDir, run
}

func assertRollbackRestoredPrevious(t *testing.T, output []byte, stateRoot string, stateDir string) {
	t.Helper()
	if !bytes.Contains(output, []byte(deployEventPrefix+"rollback|status|rollback_succeeded")) {
		t.Fatalf("rollback output:\n%s", output)
	}
	checkout, readErr := os.ReadFile(filepath.Join(stateRoot, "checkout"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if strings.TrimSpace(string(checkout)) != testPreviousCommit {
		t.Fatalf("checkout after rollback = %s", checkout)
	}
	verified, readErr := os.ReadFile(filepath.Join(stateDir, "verified.sha"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if strings.TrimSpace(string(verified)) != testPreviousCommit {
		t.Fatalf("verified state changed after failed deploy = %s", verified)
	}
}

func TestParseDeployEventsDistinguishesRollbackFailure(t *testing.T) {
	project := deployProject{}
	parseDeployEvents(&project, strings.Join([]string{
		deployEventPrefix + "rollback|status|rollback_failed",
		deployEventPrefix + "rollback|error|rollback verification failed",
		deployEventPrefix + "state|rollback_failed|deployment and rollback verification failed",
	}, "\n"))
	if project.Status != "rollback_failed" || project.Rollback == nil || project.Rollback.Status != "rollback_failed" {
		t.Fatalf("rollback failure = %#v", project)
	}
}

func deployScriptFixture(root string) (deployProject, deployOptions, string) {
	project := deployProject{
		Name: "project-space", Environment: "prod", RemoteURL: "https://example.invalid/repo.git",
		RemotePath: filepath.Join(root, "remote"), Branch: "main", ComposeProject: "project-space-prod",
		WebURL: "https://projects.example", BuildCommit: testRequestedCommit, BuildRef: "refs/heads/main",
	}
	options := deployOptions{LockTimeout: time.Second, ProjectDomain: "projects.example", APIDomain: "api.projects.example"}
	return project, options, deployTransactionScriptForPaths(project, options, filepath.Join(root, "deploy.lock"), filepath.Join(root, "state"))
}

func mustWriteExecutable(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

const fakeGitScript = `#!/bin/sh
case "$1" in
  fetch) exit 0 ;;
  rev-parse)
    case "$2" in
      refs/remotes/origin/main) echo "$REQUESTED_COMMIT" ;;
      HEAD) cat "$FAKE_STATE/checkout" ;;
      *) echo "$REQUESTED_COMMIT" ;;
    esac
    ;;
  show) echo '{"version":"0.3.0"}' ;;
  cat-file) exit 0 ;;
  reset) printf '%s\n' "$3" > "$FAKE_STATE/checkout" ;;
  merge-base) exit 0 ;;
  *) exit 0 ;;
esac
`

const fakeDockerScript = `#!/bin/sh
if [ "$1" = compose ]; then
  shift
  while [ "$1" != up ] && [ "$1" != ps ]; do shift; done
  if [ "$1" = up ]; then
    commit="$(sed -n 's/^PROJECT_SPACE_BUILD_COMMIT=//p' "$REMOTE_PATH/.env" | tail -n 1)"
    if [ "$DEPLOY_FAILURE_MODE" = compose ] && [ "$commit" = "$REQUESTED_COMMIT" ]; then exit 1; fi
    printf '%s\n' "$commit" > "$FAKE_STATE/runtime"
    if [ "$DEPLOY_FAILURE_MODE" = interrupt ] && [ "$commit" = "$REQUESTED_COMMIT" ]; then kill -TERM "$PPID"; exit 143; fi
    exit 0
  fi
  echo "$2-container"
  exit 0
fi
if [ "$1" = inspect ]; then
  case "$3" in
    *State.Status*) echo running ;;
    *State.Health*) echo healthy ;;
    *Config.Env*) printf 'PROJECT_SPACE_BUILD_COMMIT=%s\n' "$(cat "$FAKE_STATE/runtime")" ;;
    *Image*) echo sha256:test-image ;;
  esac
  exit 0
fi
if [ "$1" = image ]; then
  if [ "$LEGACY_IMAGE" = true ] && [ "$(cat "$FAKE_STATE/runtime")" = "$PREVIOUS_COMMIT" ]; then echo unknown; else cat "$FAKE_STATE/runtime"; fi
  exit 0
fi
if [ "$1" = exec ]; then exit 0; fi
exit 1
`

const fakeCurlScript = `#!/bin/sh
url=""
for value in "$@"; do case "$value" in http*) url="$value";; esac; done
if [ "$DEPLOY_FAILURE_MODE" = transient ] && [ "$(cat "$FAKE_STATE/runtime")" = "$REQUESTED_COMMIT" ]; then
  transient_count="$(cat "$FAKE_STATE/transient-count" 2>/dev/null || echo 0)"
  transient_count=$((transient_count + 1))
  printf '%s\n' "$transient_count" > "$FAKE_STATE/transient-count"
  [ "$transient_count" -gt 2 ] || exit 22
fi
case "$url" in
  */api/app/meta) printf '{"commit":"%s"}' "$(cat "$FAKE_STATE/runtime")" ;;
  */api/health)
    if [ "$DEPLOY_FAILURE_MODE" = health ] && [ "$(cat "$FAKE_STATE/runtime")" = "$REQUESTED_COMMIT" ]; then printf '{"ok":false}'; else printf '{"ok":true}'; fi ;;
  *) printf '<html></html>' ;;
esac
`
