package workspacesession

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestControlReceiverExecutesOnlyFixedReadOnlySummaries(t *testing.T) {
	receiver, calls := controlReceiverFixture(t)
	operations := []struct {
		operation string
		staged    *bool
		want      interface{}
	}{
		{"git.status", nil, gitStatusSummary{Clean: false, Staged: 1, Untracked: 1}},
		{"git.diff", boolPointer(true), gitDiffSummary{AddedLines: 3, BinaryFiles: 1, ChangedFiles: 2, DeletedLines: 2, Staged: true}},
		{"worktree.list", nil, worktreeSummary{Current: 1, Detached: 1, Locked: 1, Total: 2}},
		{"dev-server.inspect", nil, devServerSummary{Failed: 1, Ready: 1, Total: 2}},
	}
	for index, operation := range operations {
		command := controlTestCommand(receiver, int64(index+1), operation.operation, operation.staged)
		var emitted []controlResponse
		if err := receiver.handle(context.Background(), mustJSON(t, command), func(response controlResponse) error {
			emitted = append(emitted, response)
			return nil
		}); err != nil {
			t.Fatalf("%s: %v", operation.operation, err)
		}
		if len(emitted) != 2 || emitted[0].Type != "runtime.control.command-accepted" ||
			emitted[0].EventSequence == nil || emitted[1].EventSequence == nil ||
			*emitted[1].EventSequence != *emitted[0].EventSequence+1 ||
			emitted[1].Type != "runtime.control.result" || !reflect.DeepEqual(emitted[1].Output, operation.want) {
			t.Fatalf("%s responses = %#v", operation.operation, emitted)
		}
		encoded := string(mustJSON(t, emitted[1]))
		for _, forbidden := range []string{"secret/path", "private.txt", "raw patch", "web-secret", "127.0.0.1"} {
			if strings.Contains(encoded, forbidden) {
				t.Fatalf("%s leaked %q: %s", operation.operation, forbidden, encoded)
			}
		}
	}
	if len(*calls) != 6 {
		t.Fatalf("git calls = %#v", *calls)
	}
	for _, call := range (*calls)[3:] {
		joined := strings.Join(call, "\x00")
		if !strings.Contains(joined, "--no-pager") || !strings.Contains(joined, "--no-optional-locks") ||
			!strings.Contains(joined, receiver.bootstrap.WorkspacePath) {
			t.Fatalf("unbound git invocation = %#v", call)
		}
	}
	if got := strings.Join((*calls)[4], " "); !strings.Contains(got, "--cached --numstat -z --no-ext-diff --no-textconv --no-renames --") {
		t.Fatalf("unsafe git diff argv = %q", got)
	}
}

func TestControlRegistrationCarriesDurableWatermarksAndReplaysUnackedEvents(t *testing.T) {
	receiver, _ := controlReceiverFixture(t)
	command := controlTestCommand(receiver, 1, "git.status", nil)
	if err := receiver.handle(context.Background(), mustJSON(t, command), func(controlResponse) error { return nil }); err != nil {
		t.Fatal(err)
	}
	registration := Registration{}
	addControlRegistration(&registration, receiver)
	if !reflect.DeepEqual(registration.ReadyCapabilities, []string{controlCapability}) ||
		registration.ResumeAfterControlCommandSequence == nil || *registration.ResumeAfterControlCommandSequence != 1 ||
		registration.ResumeAfterControlEventSequence == nil || *registration.ResumeAfterControlEventSequence != 2 {
		t.Fatalf("control registration = %#v", registration)
	}
	replayed, err := receiver.bind("session-two", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(replayed) != 1 || replayed[0].Type != "runtime.control.result" || replayed[0].SessionID != "session-two" ||
		replayed[0].EventSequence == nil || *replayed[0].EventSequence != 2 {
		t.Fatalf("unacknowledged replay = %#v", replayed)
	}
	if err := receiver.acknowledge(2); err != nil {
		t.Fatal(err)
	}
	if _, err := receiver.bind("session-three", 1); err == nil {
		t.Fatal("server event watermark regression was accepted")
	}
}

func TestControlReceiverReplaysCompletedCommandWithoutExecution(t *testing.T) {
	receiver, calls := controlReceiverFixture(t)
	command := controlTestCommand(receiver, 1, "git.status", nil)
	var first []controlResponse
	if err := receiver.handle(context.Background(), mustJSON(t, command), func(response controlResponse) error {
		first = append(first, response)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 4 {
		t.Fatalf("first execution calls = %#v", *calls)
	}
	loaded, err := loadControlJournal(receiver.path, receiver.journal.BindingDigest)
	if err != nil {
		t.Fatal(err)
	}
	receiver = &controlReceiver{
		bootstrap: receiver.bootstrap, journal: loaded, path: receiver.path, run: receiver.run,
		sessionID: "session-two",
	}
	command.SessionID = "session-two"
	var replay []controlResponse
	if err := receiver.handle(context.Background(), mustJSON(t, command), func(response controlResponse) error {
		replay = append(replay, response)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 4 {
		t.Fatalf("replay re-executed git: %#v", *calls)
	}
	if len(replay) != 2 || replay[0].Replayed == nil || !*replay[0].Replayed ||
		replay[1].SessionID != "session-two" || string(mustJSON(t, first[1].Output)) != string(mustJSON(t, replay[1].Output)) {
		t.Fatalf("replay = %#v", replay)
	}
	conflict := command
	conflict.ActorID = "different-actor"
	if err := receiver.handle(context.Background(), mustJSON(t, conflict), func(controlResponse) error { return nil }); err == nil {
		t.Fatal("conflicting replay was accepted")
	}
}

func TestControlReceiverInterruptedCommandBecomesDurableUncertain(t *testing.T) {
	receiver, calls := controlReceiverFixture(t)
	command := controlTestCommand(receiver, 1, "git.status", nil)
	fingerprint, err := controlFingerprint(command)
	if err != nil {
		t.Fatal(err)
	}
	receiver.journal.AcceptedCommandSequence = 1
	receiver.journal.Commands = append(receiver.journal.Commands, controlCommandRecord{
		Fingerprint: fingerprint, Responses: []controlResponse{receiver.acceptedResponse(command, false)},
		Sequence: 1, State: "uncertain",
	})
	receiver.journal.LastEventSequence = 1
	if err := saveControlJournal(receiver.path, receiver.journal); err != nil {
		t.Fatal(err)
	}
	var emitted []controlResponse
	if err := receiver.handle(context.Background(), mustJSON(t, command), func(response controlResponse) error {
		emitted = append(emitted, response)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 3 {
		t.Fatalf("uncertain command executed git: %#v", *calls)
	}
	if len(emitted) != 2 || emitted[1].Type != "runtime.control.error" || emitted[1].Code != "uncertain" {
		t.Fatalf("uncertain replay = %#v", emitted)
	}
	loaded, err := loadControlJournal(receiver.path, receiver.journal.BindingDigest)
	if err != nil || len(loaded.Commands[0].Responses) != 2 || loaded.Commands[0].State != "uncertain" {
		t.Fatalf("durable uncertainty = %#v, error=%v", loaded, err)
	}
}

func TestControlReceiverRejectsForeignBindingAndUnboundedInput(t *testing.T) {
	receiver, _ := controlReceiverFixture(t)
	tests := []controlCommand{
		func() controlCommand {
			value := controlTestCommand(receiver, 1, "git.status", nil)
			value.ActorUserID = "foreign"
			return value
		}(),
		func() controlCommand {
			value := controlTestCommand(receiver, 1, "git.status", nil)
			value.Generation = "33333333-3333-4333-8333-333333333333"
			return value
		}(),
		func() controlCommand { value := controlTestCommand(receiver, 2, "git.status", nil); return value }(),
	}
	for _, command := range tests {
		if err := receiver.handle(context.Background(), mustJSON(t, command), func(controlResponse) error { return nil }); err == nil {
			t.Fatalf("unsafe command was accepted: %#v", command)
		}
	}
	raw := map[string]interface{}{}
	if json.Unmarshal(mustJSON(t, controlTestCommand(receiver, 1, "git.status", nil)), &raw) != nil {
		t.Fatal("decode fixture")
	}
	raw["path"] = "/tmp/foreign"
	if err := receiver.handle(context.Background(), mustJSON(t, raw), func(controlResponse) error { return nil }); err == nil {
		t.Fatal("caller-provided path was accepted")
	}
}

func TestControlJournalRejectsPublicOrMismatchedState(t *testing.T) {
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "journal.json")
	state := controlJournal{BindingDigest: strings.Repeat("a", 64), Commands: []controlCommandRecord{}, Schema: controlJournalSchema}
	if err := saveControlJournal(path, state); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("journal mode = %#v, error=%v", info, err)
	}
	if _, err := loadControlJournal(path, strings.Repeat("b", 64)); err == nil {
		t.Fatal("journal binding change was accepted")
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadControlJournal(path, strings.Repeat("a", 64)); err == nil {
		t.Fatal("public journal was accepted")
	}
}

func TestControlOutputBufferFailsClosedAtTheByteLimit(t *testing.T) {
	buffer := &boundedControlBuffer{remaining: 4}
	if _, err := buffer.Write([]byte("safe")); err != nil {
		t.Fatal(err)
	}
	if _, err := buffer.Write([]byte("overflow")); err == nil {
		t.Fatal("oversized command output was accepted")
	}
}

func TestControlReceiverInspectsARealRepresentativeGitWorkspace(t *testing.T) {
	workspace := t.TempDir()
	workspaceID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	runGitTestCommand(t, workspace, "init", "-b", "issue-657")
	runGitTestCommand(t, workspace, "config", "user.name", "Project Test")
	runGitTestCommand(t, workspace, "config", "user.email", "project@example.invalid")
	runGitTestCommand(t, workspace, "config", "extensions.worktreeConfig", "true")
	runGitTestCommand(t, workspace, "config", "--worktree", "project.workspaceId", workspaceID)
	if err := os.WriteFile(filepath.Join(workspace, "tracked.txt"), []byte("before\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGitTestCommand(t, workspace, "add", "tracked.txt")
	runGitTestCommand(t, workspace, "commit", "-m", "fixture")
	commit := strings.TrimSpace(runGitTestCommand(t, workspace, "rev-parse", "HEAD"))
	if err := os.WriteFile(filepath.Join(workspace, "tracked.txt"), []byte("after\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	private := t.TempDir()
	if err := os.Chmod(private, 0o700); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(private, "state.json")
	if err := os.WriteFile(statePath, []byte(`{"lifecycleState":"running","devServers":[{"name":"docs","port":3000,"state":"ready"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	original, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(workspace); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(original)
	receiver, err := newControlReceiver(Bootstrap{
		WorkspaceID: workspaceID, EnvironmentID: "11111111-1111-4111-8111-111111111111",
		Generation: "22222222-2222-4222-8222-222222222222", Branch: "issue-657", Commit: commit,
		ManifestDigest: strings.Repeat("b", 64), OwnerUserID: "owner", WorkspacePath: workspace,
		JournalPath: filepath.Join(private, "session.json"), StatePath: statePath,
		RequestedCapabilities: []string{controlCapability}, ExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := receiver.bind("session-real", 0); err != nil {
		t.Fatal(err)
	}
	operations := []struct {
		name   string
		staged *bool
	}{
		{"git.status", nil}, {"git.diff", boolPointer(false)},
		{"worktree.list", nil}, {"dev-server.inspect", nil},
	}
	for index, operation := range operations {
		var responses []controlResponse
		if err := receiver.handle(
			context.Background(),
			mustJSON(t, controlTestCommand(receiver, int64(index+1), operation.name, operation.staged)),
			func(response controlResponse) error { responses = append(responses, response); return nil },
		); err != nil {
			t.Fatalf("%s: %v", operation.name, err)
		}
		if len(responses) != 2 || responses[1].Type != "runtime.control.result" ||
			strings.Contains(string(mustJSON(t, responses[1])), workspace) {
			t.Fatalf("%s unsafe result: %#v", operation.name, responses)
		}
	}
}

func runGitTestCommand(t *testing.T, directory string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, args...)...)
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
	return string(output)
}

func controlReceiverFixture(t *testing.T) (*controlReceiver, *[][]string) {
	t.Helper()
	workspace, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	workspace, err = canonicalControlWorkspace(workspace)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(directory, "state.json")
	if err := os.WriteFile(statePath, []byte(`{"lifecycleState":"running","devServers":[{"name":"web-secret","port":3000,"state":"ready","url":"http://127.0.0.1:3000/"},{"name":"failed","port":3001,"state":"failed"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	bootstrap := Bootstrap{
		WorkspaceID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", EnvironmentID: "11111111-1111-4111-8111-111111111111",
		Generation: "22222222-2222-4222-8222-222222222222", Branch: "issue-657", Commit: strings.Repeat("a", 40),
		ManifestDigest: strings.Repeat("b", 64), OwnerUserID: "owner", WorkspacePath: workspace,
		JournalPath: filepath.Join(directory, "session.json"), StatePath: statePath,
		RequestedCapabilities: []string{controlCapability}, ExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339),
	}
	calls := &[][]string{}
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		*calls = append(*calls, append([]string{name}, args...))
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "rev-parse --verify HEAD"):
			return []byte(bootstrap.Commit + "\n"), nil
		case strings.Contains(joined, "branch --show-current"):
			return []byte(bootstrap.Branch + "\n"), nil
		case strings.Contains(joined, "config --worktree --get project.workspaceId"):
			return []byte(bootstrap.WorkspaceID + "\n"), nil
		case strings.Contains(joined, "status --porcelain"):
			return []byte("M  secret/path\x00?? private.txt\x00"), nil
		case strings.Contains(joined, "diff --cached"):
			return []byte("3\t2\tsecret/path\x00-\t-\tbinary-secret\x00"), nil
		case strings.Contains(joined, "worktree list"):
			return []byte("worktree " + workspace + "\x00HEAD " + strings.Repeat("a", 40) + "\x00branch refs/heads/issue-657\x00\x00" +
				"worktree /unavailable/secret-path\x00HEAD " + strings.Repeat("b", 40) + "\x00detached\x00locked reason\x00\x00"), nil
		default:
			return nil, context.Canceled
		}
	}
	receiver, err := newControlReceiver(bootstrap, run)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := receiver.bind("session-one", 0); err != nil {
		t.Fatal(err)
	}
	return receiver, calls
}

func controlTestCommand(receiver *controlReceiver, sequence int64, operation string, staged *bool) controlCommand {
	return controlCommand{
		ActorID: "agent-one", ActorKind: "agent", ActorUserID: receiver.bootstrap.OwnerUserID,
		CommandID: "operation-one-" + string(rune('a'+sequence-1)), CommandSequence: sequence,
		EnvironmentID: receiver.bootstrap.EnvironmentID, Generation: receiver.bootstrap.Generation,
		Operation: operation, OperationID: "operation-one-" + string(rune('a'+sequence-1)), SchemaVersion: 1,
		SessionID: receiver.sessionID, Staged: staged, TargetIdentityRevision: "7:environment_canonical",
		Type: "runtime.control.command", WorkspaceID: receiver.bootstrap.WorkspaceID,
	}
}

func boolPointer(value bool) *bool { return &value }

func mustJSON(t *testing.T, value interface{}) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
