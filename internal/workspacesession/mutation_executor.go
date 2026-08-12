package workspacesession

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/DotNaos/project-space/internal/worktreeownership"
)

const maximumCommitMessageBytes = 256

type RuntimeMutationExecutor interface {
	MutateDevServer(context.Context, DevServerMutationRequest) (DevServerMutationOutput, error)
}

type DevServerMutationRequest struct {
	Directory                string
	ExpectedCommit           string
	ExpectedGeneration       string
	ExpectedManifestDigest   string
	ExpectedServerGeneration string
	Operation                string
	OperationID              string
	ServerID                 string
	WorkspaceID              string
}

type DevServerMutationOutput struct {
	ServerID         string `json:"serverId"`
	ServerGeneration string `json:"serverGeneration"`
	State            string `json:"state"`
}

type mutationEvidence struct {
	ExpectedCommit   string `json:"expectedCommit,omitempty"`
	ExpectedHead     string `json:"expectedHead,omitempty"`
	IndexTree        string `json:"indexTree,omitempty"`
	MessageDigest    string `json:"messageDigest,omitempty"`
	Operation        string `json:"operation"`
	ServerID         string `json:"serverId,omitempty"`
	ServerGeneration string `json:"serverGeneration,omitempty"`
	TaskExecutionID  string `json:"taskExecutionId,omitempty"`
	WorkspaceLeaseID string `json:"workspaceLeaseId,omitempty"`
}

type gitMutationSummary struct {
	Changed    bool   `json:"changed"`
	Clean      bool   `json:"clean"`
	Conflicted int    `json:"conflicted"`
	Head       string `json:"head"`
	Staged     int    `json:"staged"`
	Truncated  bool   `json:"truncated"`
	Unstaged   int    `json:"unstaged"`
	Untracked  int    `json:"untracked"`
}

type gitCommitSummary struct {
	Commit string `json:"commit"`
	Parent string `json:"parent"`
}

type taskActivationSummary struct {
	TaskExecutionID string `json:"taskExecutionId"`
	State           string `json:"state"`
}

type taskActivationRecord struct {
	Generation       string `json:"generation"`
	OwnerUserID      string `json:"ownerUserId"`
	TaskExecutionID  string `json:"taskExecutionId"`
	WorkspaceID      string `json:"workspaceId"`
	WorkspaceLeaseID string `json:"workspaceLeaseId"`
}

func isMutationOperation(operation string) bool {
	return oneOf(operation, "git.stage", "git.unstage", "git.commit", "task.start",
		"dev-server.start", "dev-server.publish", "dev-server.stop")
}

func (receiver *controlReceiver) validMutationInput(command controlCommand) bool {
	switch command.Operation {
	case "git.stage", "git.unstage":
		return command.Scope == "all" && command.ExpectedHead == receiver.bootstrap.Commit
	case "git.commit":
		return command.ExpectedHead == receiver.bootstrap.Commit && validCommitMessage(command.Message)
	case "task.start":
		return uuidPattern.MatchString(command.TaskExecutionID) &&
			uuidPattern.MatchString(command.WorkspaceLeaseID) &&
			command.WorkspaceLeaseID == receiver.bootstrap.WorkspaceID
	case "dev-server.start":
		return controlDevServerNamePattern.MatchString(command.ServerID)
	case "dev-server.publish", "dev-server.stop":
		return controlDevServerNamePattern.MatchString(command.ServerID) &&
			controlIdentifierPattern.MatchString(command.ExpectedServerGeneration)
	default:
		return false
	}
}

func validCommitMessage(message string) bool {
	if message == "" || len(message) > maximumCommitMessageBytes || strings.TrimSpace(message) != message {
		return false
	}
	for _, character := range message {
		if character == 127 || character < 32 {
			return false
		}
	}
	return true
}

func (receiver *controlReceiver) prepareMutationEvidence(ctx context.Context, command controlCommand) (*mutationEvidence, error) {
	if receiver.mutationFenced {
		return nil, fmt.Errorf("Workspace Runtime mutations are fenced until the committed target is rebound")
	}
	if err := receiver.verifyMutationTarget(ctx); err != nil {
		return nil, err
	}
	evidence := &mutationEvidence{Operation: command.Operation}
	switch command.Operation {
	case "git.stage", "git.unstage":
		if err := receiver.rejectGitFilters(ctx); err != nil {
			return nil, err
		}
		evidence.ExpectedHead = command.ExpectedHead
		indexTree, err := receiver.gitIndexTree(ctx)
		if err != nil {
			return nil, err
		}
		evidence.IndexTree = indexTree
	case "git.commit":
		if err := receiver.rejectGitFilters(ctx); err != nil {
			return nil, err
		}
		evidence.ExpectedHead = command.ExpectedHead
		tree, err := receiver.runMutationGit(ctx, nil, "write-tree")
		if err != nil || !commitPattern.MatchString(strings.TrimSpace(string(tree))) {
			return nil, fmt.Errorf("staged Git tree is unavailable")
		}
		evidence.IndexTree = strings.TrimSpace(string(tree))
		digest := sha256.Sum256([]byte(command.Message))
		evidence.MessageDigest = hex.EncodeToString(digest[:])
	case "task.start":
		if err := receiver.preflightTaskActivation(command); err != nil {
			return nil, err
		}
		evidence.TaskExecutionID = command.TaskExecutionID
		evidence.WorkspaceLeaseID = command.WorkspaceLeaseID
	case "dev-server.start":
		evidence.ServerID = command.ServerID
	case "dev-server.publish", "dev-server.stop":
		evidence.ServerID = command.ServerID
		evidence.ServerGeneration = command.ExpectedServerGeneration
	}
	return evidence, nil
}

func validateMutationEvidence(evidence mutationEvidence) error {
	if !isMutationOperation(evidence.Operation) {
		return fmt.Errorf("mutation evidence operation is invalid")
	}
	switch evidence.Operation {
	case "git.stage", "git.unstage":
		if !commitPattern.MatchString(evidence.ExpectedHead) || !commitPattern.MatchString(evidence.IndexTree) {
			return fmt.Errorf("mutation expected HEAD is invalid")
		}
	case "git.commit":
		if !commitPattern.MatchString(evidence.ExpectedHead) || !commitPattern.MatchString(evidence.IndexTree) ||
			len(evidence.MessageDigest) != 64 ||
			(evidence.ExpectedCommit != "" && !commitPattern.MatchString(evidence.ExpectedCommit)) {
			return fmt.Errorf("commit evidence is invalid")
		}
	case "task.start":
		if !uuidPattern.MatchString(evidence.TaskExecutionID) || !uuidPattern.MatchString(evidence.WorkspaceLeaseID) {
			return fmt.Errorf("task activation evidence is invalid")
		}
	case "dev-server.start":
		if !controlDevServerNamePattern.MatchString(evidence.ServerID) {
			return fmt.Errorf("dev-server evidence is invalid")
		}
	case "dev-server.publish", "dev-server.stop":
		if !controlDevServerNamePattern.MatchString(evidence.ServerID) ||
			!controlIdentifierPattern.MatchString(evidence.ServerGeneration) {
			return fmt.Errorf("dev-server generation evidence is invalid")
		}
	}
	return nil
}

func (receiver *controlReceiver) executeMutation(ctx context.Context, command controlCommand) (interface{}, error) {
	if receiver.mutationFenced {
		return nil, fmt.Errorf("Workspace Runtime mutation target requires restart")
	}
	if err := receiver.verifyMutationTarget(ctx); err != nil {
		return nil, err
	}
	record := receiver.journal.command(command.CommandSequence)
	if record == nil || record.Mutation == nil || record.Mutation.Operation != command.Operation {
		return nil, fmt.Errorf("Workspace Runtime mutation intent is unavailable")
	}
	switch command.Operation {
	case "git.stage":
		return receiver.mutateGitIndex(ctx, true, command.ExpectedHead, record.Mutation.IndexTree)
	case "git.unstage":
		return receiver.mutateGitIndex(ctx, false, command.ExpectedHead, record.Mutation.IndexTree)
	case "git.commit":
		return receiver.commitGit(ctx, command, record.Mutation.IndexTree)
	case "task.start":
		return receiver.activateTask(command)
	case "dev-server.start", "dev-server.publish", "dev-server.stop":
		return receiver.mutateDevServer(ctx, command)
	default:
		return nil, fmt.Errorf("unsupported Workspace Runtime mutation operation")
	}
}

func (receiver *controlReceiver) verifyMutationTarget(ctx context.Context) error {
	if err := receiver.verifyMutationWorkspace(); err != nil {
		return err
	}
	head, err := receiver.currentGitHead(ctx)
	if err != nil || head != receiver.bootstrap.Commit {
		return fmt.Errorf("Workspace Runtime mutation target changed")
	}
	return nil
}

func (receiver *controlReceiver) verifyMutationWorkspace() error {
	managed, err := worktreeownership.InspectManaged(receiver.bootstrap.WorkspacePath)
	if err != nil || managed.Path != receiver.bootstrap.WorkspacePath ||
		managed.WorkspaceID != receiver.bootstrap.WorkspaceID ||
		managed.Owner != receiver.bootstrap.WorktreeOwnerThreadID {
		return fmt.Errorf("Workspace Runtime mutation ownership changed")
	}
	return nil
}

func (receiver *controlReceiver) mutateGitIndex(
	ctx context.Context,
	stage bool,
	expectedHead string,
	expectedIndexTree string,
) (gitMutationSummary, error) {
	if err := receiver.rejectGitFilters(ctx); err != nil {
		return gitMutationSummary{}, err
	}
	head, err := receiver.currentGitHead(ctx)
	if err != nil || head != expectedHead {
		return gitMutationSummary{}, fmt.Errorf("Git mutation target changed")
	}
	before, err := receiver.gitIndexTree(ctx)
	if err != nil {
		return gitMutationSummary{}, err
	}
	if before != expectedIndexTree {
		return gitMutationSummary{}, fmt.Errorf("Git index changed after mutation intent was recorded")
	}
	args := []string{"add", "-A", "--", "."}
	if !stage {
		args = []string{"restore", "--staged", "--", "."}
	}
	if _, err := receiver.runMutationGit(ctx, nil, args...); err != nil {
		return gitMutationSummary{}, err
	}
	after, err := receiver.gitIndexTree(ctx)
	if err != nil {
		return gitMutationSummary{}, err
	}
	head, err = receiver.currentGitHead(ctx)
	if err != nil {
		return gitMutationSummary{}, err
	}
	return receiver.gitMutationOutput(ctx, before != after, head)
}

func (receiver *controlReceiver) commitGit(ctx context.Context, command controlCommand, expectedIndexTree string) (gitCommitSummary, error) {
	if err := receiver.rejectGitFilters(ctx); err != nil {
		return gitCommitSummary{}, err
	}
	head, err := receiver.currentGitHead(ctx)
	if err != nil || head != command.ExpectedHead {
		return gitCommitSummary{}, fmt.Errorf("Git commit target changed")
	}
	count, err := receiver.stagedFileCount(ctx)
	if err != nil || count == 0 {
		return gitCommitSummary{}, fmt.Errorf("Git commit requires staged changes")
	}
	tree, err := receiver.gitIndexTree(ctx)
	if err != nil {
		return gitCommitSummary{}, err
	}
	if tree != expectedIndexTree {
		return gitCommitSummary{}, fmt.Errorf("Git index changed after commit intent was recorded")
	}
	created, err := receiver.runMutationGit(ctx, []byte(command.Message+"\n"),
		"-c", "commit.gpgSign=false", "commit-tree", tree, "-p", command.ExpectedHead)
	commit := strings.TrimSpace(string(created))
	if err != nil {
		return gitCommitSummary{}, err
	}
	if !commitPattern.MatchString(commit) {
		return gitCommitSummary{}, fmt.Errorf("Git commit evidence is invalid")
	}
	record := receiver.journal.command(command.CommandSequence)
	if record == nil || record.Mutation == nil {
		return gitCommitSummary{}, fmt.Errorf("Git commit intent is unavailable")
	}
	record.Mutation.ExpectedCommit = commit
	if err := saveControlJournal(receiver.path, receiver.journal); err != nil {
		return gitCommitSummary{}, err
	}
	if _, err := receiver.runMutationGit(ctx, nil, "update-ref", "HEAD", commit, command.ExpectedHead); err != nil {
		return gitCommitSummary{}, err
	}
	return gitCommitSummary{Commit: commit, Parent: command.ExpectedHead}, nil
}

func (receiver *controlReceiver) rejectGitFilters(ctx context.Context) error {
	for _, scope := range []string{"--local", "--worktree"} {
		for _, pattern := range []string{`^filter\..*\.(clean|process)$`, `^include(if)?\.`} {
			output, err := receiver.runMutationGit(ctx, nil, "config", scope, "--no-includes", "--get-regexp", pattern)
			if err == nil && len(bytes.TrimSpace(output)) != 0 {
				return fmt.Errorf("repository Git execution filters are not allowed")
			}
			var exit *exec.ExitError
			if err != nil && (!errors.As(err, &exit) || exit.ExitCode() != 1) {
				return fmt.Errorf("repository Git execution policy is unavailable")
			}
		}
	}
	paths, err := receiver.runMutationGit(ctx, nil, "ls-files", "-co", "--exclude-standard", "-z", "--")
	if err != nil {
		return fmt.Errorf("repository Git attribute inventory is unavailable")
	}
	if len(paths) > 0 {
		attributes, err := receiver.runMutationGit(ctx, paths, "check-attr", "-z", "--stdin", "filter")
		if err != nil {
			return fmt.Errorf("repository Git attribute policy is unavailable")
		}
		fields := bytes.Split(attributes, []byte{0})
		for index := 2; index < len(fields); index += 3 {
			value := string(fields[index])
			if value != "" && value != "unspecified" && value != "unset" {
				return fmt.Errorf("repository Git execution filters are not allowed")
			}
		}
	}
	return nil
}

func (receiver *controlReceiver) gitIndexTree(ctx context.Context) (string, error) {
	output, err := receiver.runMutationGit(ctx, nil, "write-tree")
	tree := strings.TrimSpace(string(output))
	if err != nil || !commitPattern.MatchString(tree) {
		return "", fmt.Errorf("Workspace Git index is unavailable")
	}
	return tree, nil
}

func (receiver *controlReceiver) stagedFileCount(ctx context.Context) (int, error) {
	output, err := receiver.runMutationGit(ctx, nil, "diff", "--cached", "--name-only", "-z", "--no-renames", "--")
	if err != nil {
		return 0, err
	}
	if len(output) == 0 {
		return 0, nil
	}
	if output[len(output)-1] != 0 {
		return 0, fmt.Errorf("invalid staged Git summary")
	}
	return bytes.Count(output, []byte{0}), nil
}

func (receiver *controlReceiver) gitMutationOutput(ctx context.Context, changed bool, head string) (gitMutationSummary, error) {
	status, err := receiver.runMutationGit(ctx, nil, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames")
	if err != nil {
		return gitMutationSummary{}, err
	}
	summary, err := summarizeGitStatus(status)
	return gitMutationSummary{
		Changed: changed, Clean: summary.Clean, Conflicted: summary.Conflicted, Head: head,
		Staged: summary.Staged, Truncated: summary.Truncated, Unstaged: summary.Unstaged, Untracked: summary.Untracked,
	}, err
}

func (receiver *controlReceiver) currentGitHead(ctx context.Context) (string, error) {
	output, err := receiver.runMutationGit(ctx, nil, "rev-parse", "--verify", "HEAD")
	head := strings.TrimSpace(string(output))
	if err != nil || !commitPattern.MatchString(head) {
		return "", fmt.Errorf("Workspace Git HEAD is unavailable")
	}
	return head, nil
}

func (receiver *controlReceiver) runMutationGit(ctx context.Context, stdin []byte, args ...string) ([]byte, error) {
	fixed := []string{
		"--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false",
		"-c", "core.untrackedCache=false", "-c", "color.ui=false",
		"-c", "core.hooksPath=" + os.DevNull,
		"-C", receiver.bootstrap.WorkspacePath,
	}
	return runBoundedMutationCommand(ctx, stdin, "git", append(fixed, args...)...)
}

func runBoundedMutationCommand(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Env = []string{
		"GIT_CONFIG_GLOBAL=" + os.DevNull, "GIT_CONFIG_NOSYSTEM=1", "GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0", "LC_ALL=C", "PATH=" + os.Getenv("PATH"),
	}
	command.Stdin = bytes.NewReader(stdin)
	output := &boundedControlBuffer{remaining: controlOutputLimit}
	command.Stdout = output
	command.Stderr = &boundedControlBuffer{remaining: 4096}
	if err := command.Run(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func (receiver *controlReceiver) mutateDevServer(ctx context.Context, command controlCommand) (interface{}, error) {
	if receiver.mutations == nil {
		return nil, fmt.Errorf("Workspace Runtime dev-server mutation is unavailable")
	}
	operation := strings.TrimPrefix(command.Operation, "dev-server.")
	output, err := receiver.mutations.MutateDevServer(ctx, DevServerMutationRequest{
		Directory: receiver.bootstrap.WorkspacePath, Operation: operation, ServerID: command.ServerID,
		OperationID:              command.OperationID,
		ExpectedServerGeneration: command.ExpectedServerGeneration,
		ExpectedCommit:           receiver.bootstrap.Commit, ExpectedManifestDigest: receiver.bootstrap.ManifestDigest,
		ExpectedGeneration: receiver.bootstrap.Generation, WorkspaceID: receiver.bootstrap.WorkspaceID,
	})
	if err != nil {
		return nil, err
	}
	expectedState := map[string]string{"start": "ready", "publish": "published", "stop": "stopped"}[operation]
	if output.ServerID != command.ServerID || !controlIdentifierPattern.MatchString(output.ServerGeneration) ||
		output.State != expectedState {
		return nil, fmt.Errorf("Workspace Runtime dev-server mutation output is invalid")
	}
	return output, nil
}

func (receiver *controlReceiver) recoverInterrupted(ctx context.Context, command controlCommand, record *controlCommandRecord) (interface{}, bool) {
	if record.Mutation == nil || record.Mutation.Operation != command.Operation {
		return nil, false
	}
	switch command.Operation {
	case "task.start":
		output, err := receiver.activateTask(command)
		return output, err == nil
	case "git.stage", "git.unstage":
		output, err := receiver.recoverGitIndex(ctx, command.Operation == "git.stage", *record.Mutation)
		return output, err == nil
	case "git.commit":
		var output gitCommitSummary
		var err error
		if record.Mutation.ExpectedCommit == "" {
			output, err = receiver.commitGit(ctx, command, record.Mutation.IndexTree)
		} else {
			output, err = receiver.recoverGitCommit(ctx, *record.Mutation)
		}
		if err == nil {
			receiver.journal.MutationFenced = true
			receiver.mutationFenced = true
		}
		return output, err == nil
	case "dev-server.start", "dev-server.publish", "dev-server.stop":
		output, err := receiver.mutateDevServer(ctx, command)
		return output, err == nil
	default:
		return nil, false
	}
}

func (receiver *controlReceiver) recoverGitIndex(ctx context.Context, staged bool, evidence mutationEvidence) (gitMutationSummary, error) {
	head, err := receiver.currentGitHead(ctx)
	if err != nil || head != receiver.bootstrap.Commit {
		return gitMutationSummary{}, fmt.Errorf("Git mutation target changed")
	}
	status, err := receiver.runMutationGit(ctx, nil, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames")
	if err != nil {
		return gitMutationSummary{}, err
	}
	summary, err := summarizeGitStatus(status)
	if err != nil || staged && (summary.Unstaged != 0 || summary.Untracked != 0) || !staged && summary.Staged != 0 {
		return gitMutationSummary{}, fmt.Errorf("Git index mutation outcome is uncertain")
	}
	indexTree, err := receiver.gitIndexTree(ctx)
	if err != nil {
		return gitMutationSummary{}, err
	}
	return receiver.gitMutationOutput(ctx, indexTree != evidence.IndexTree, head)
}

func (receiver *controlReceiver) recoverGitCommit(ctx context.Context, evidence mutationEvidence) (gitCommitSummary, error) {
	commit, err := receiver.currentGitHead(ctx)
	if err != nil || commit == evidence.ExpectedHead || evidence.ExpectedCommit == "" ||
		commit != evidence.ExpectedCommit {
		return gitCommitSummary{}, fmt.Errorf("Git commit outcome is uncertain")
	}
	parent, err := receiver.runMutationGit(ctx, nil, "rev-parse", "--verify", commit+"^")
	if err != nil || strings.TrimSpace(string(parent)) != evidence.ExpectedHead {
		return gitCommitSummary{}, fmt.Errorf("Git commit parent changed")
	}
	tree, err := receiver.runMutationGit(ctx, nil, "rev-parse", "--verify", commit+"^{tree}")
	if err != nil || strings.TrimSpace(string(tree)) != evidence.IndexTree {
		return gitCommitSummary{}, fmt.Errorf("Git commit tree changed")
	}
	message, err := receiver.runMutationGit(ctx, nil, "log", "-1", "--format=%B", commit)
	normalized := strings.TrimSuffix(string(message), "\n")
	digest := sha256.Sum256([]byte(normalized))
	if err != nil || hex.EncodeToString(digest[:]) != evidence.MessageDigest {
		return gitCommitSummary{}, fmt.Errorf("Git commit message changed")
	}
	return gitCommitSummary{Commit: commit, Parent: evidence.ExpectedHead}, nil
}
