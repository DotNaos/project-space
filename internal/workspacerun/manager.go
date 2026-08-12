package workspacerun

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/DotNaos/project-space/internal/worktreeownership"
)

type CheckoutVerifier interface {
	Verify(context.Context, WorkspaceIdentity, OperationOptions) error
}

type ManagedCheckoutVerifier struct{}

func (ManagedCheckoutVerifier) Verify(_ context.Context, identity WorkspaceIdentity, options OperationOptions) error {
	checked, err := worktreeownership.InspectManaged(identity.Directory)
	if err != nil {
		return err
	}
	if checked.Path != identity.Directory || checked.Branch != identity.Branch {
		return fmt.Errorf("managed Worktree inspection resolved a different checkout")
	}
	threadID := strings.TrimSpace(options.ThreadID)
	if threadID == "" {
		threadID = strings.TrimSpace(identity.Owner)
	}
	if threadID == "" {
		if options.TrustedGateway {
			return nil
		}
		return fmt.Errorf("managed Worktree owner thread is required")
	}
	if checked.Owner != threadID {
		return fmt.Errorf("managed Worktree belongs to a different Codex task")
	}
	return nil
}

type Dependencies struct {
	StateRoot string
	Identity  IdentityResolver
	Checkout  CheckoutVerifier
	Project   ProjectLifecycle
	Providers []RuntimeProvider
	Verifier  ToolVerifier
	Now       Clock
	Token     Token
}

type Manager struct {
	store     *stateStore
	identity  IdentityResolver
	checkout  CheckoutVerifier
	project   ProjectLifecycle
	providers map[Mode]RuntimeProvider
	verifier  ToolVerifier
	now       Clock
	token     Token
}

func NewDefaultManager() (*Manager, error) {
	root, err := defaultStateRoot()
	if err != nil {
		return nil, err
	}
	project, err := projectrun.NewDefaultManager()
	if err != nil {
		return nil, err
	}
	return NewManager(Dependencies{
		StateRoot: root, Identity: GitIdentityResolver{}, Checkout: ManagedCheckoutVerifier{},
		Project: project, Providers: []RuntimeProvider{ProcessProvider{}},
		Verifier: ExactToolVerifier{}, Now: time.Now, Token: randomToken,
	})
}

func NewManager(dependencies Dependencies) (*Manager, error) {
	if dependencies.Identity == nil || dependencies.Checkout == nil || dependencies.Project == nil || dependencies.Verifier == nil {
		return nil, fmt.Errorf("workspace runtime dependencies must not be nil")
	}
	if dependencies.Now == nil {
		dependencies.Now = time.Now
	}
	if dependencies.Token == nil {
		dependencies.Token = randomToken
	}
	providers := map[Mode]RuntimeProvider{}
	for _, provider := range dependencies.Providers {
		if provider == nil || (provider.Mode() != ModeProcess && provider.Mode() != ModeDevcontainer) {
			return nil, fmt.Errorf("workspace runtime provider is invalid")
		}
		if providers[provider.Mode()] != nil {
			return nil, fmt.Errorf("workspace runtime provider %q is duplicated", provider.Mode())
		}
		providers[provider.Mode()] = provider
	}
	store, err := newStateStore(dependencies.StateRoot)
	if err != nil {
		return nil, err
	}
	return &Manager{
		store: store, identity: dependencies.Identity, checkout: dependencies.Checkout,
		project: dependencies.Project, providers: providers, verifier: dependencies.Verifier,
		now: dependencies.Now, token: dependencies.Token,
	}, nil
}

func randomToken() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate runtime generation: %w", err)
	}
	encoded := hex.EncodeToString(value)
	return encoded[:8] + "-" + encoded[8:12] + "-4" + encoded[13:16] + "-8" + encoded[17:20] + "-" + encoded[20:], nil
}

func (manager *Manager) resolve(ctx context.Context, directory string, options OperationOptions, requireClean bool) (resolvedPlan, error) {
	plan, err := resolvePlan(ctx, manager.identity, directory, options.Mode)
	if err != nil {
		return resolvedPlan{}, err
	}
	if err := manager.checkout.Verify(ctx, plan.Identity, options); err != nil {
		return resolvedPlan{}, err
	}
	if requireClean && plan.Identity.Dirty {
		return resolvedPlan{}, fmt.Errorf("Workspace checkout must be clean before runtime launch")
	}
	if options.ExpectedWorkspaceID != "" && plan.Identity.WorkspaceID != options.ExpectedWorkspaceID {
		return resolvedPlan{}, fmt.Errorf("Workspace identity mismatch")
	}
	if options.ExpectedBranch != "" && plan.Identity.Branch != options.ExpectedBranch {
		return resolvedPlan{}, fmt.Errorf("Workspace branch mismatch: expected %s, received %s", options.ExpectedBranch, plan.Identity.Branch)
	}
	if options.ExpectedCommit != "" && plan.Identity.Head != options.ExpectedCommit {
		return resolvedPlan{}, fmt.Errorf("Workspace HEAD mismatch: expected %s, received %s", options.ExpectedCommit, plan.Identity.Head)
	}
	if options.ExpectedDigest != "" && plan.Digest != options.ExpectedDigest {
		return resolvedPlan{}, fmt.Errorf("resolved runtime manifest mismatch: expected %s, received %s", options.ExpectedDigest, plan.Digest)
	}
	return plan, nil
}

func (manager *Manager) provider(mode Mode) (RuntimeProvider, error) {
	provider := manager.providers[mode]
	if provider == nil {
		return nil, fmt.Errorf("runtime provider %q is unavailable; no fallback is allowed", mode)
	}
	return provider, nil
}

func (manager *Manager) result(operation string, disposition Disposition, record runtimeRecord, failure error) Result {
	result := Result{
		SchemaVersion: SchemaVersion, Operation: operation, Disposition: disposition,
		WorkspaceID: record.WorkspaceID, Generation: record.Generation, Directory: record.Directory,
		Repository: record.Repository, ManifestDigest: record.ManifestDigest, SourceHead: record.Head,
		Mode: record.Mode, State: record.State, Resources: record.Resources,
		DevServers: append([]ManagedDevServer{}, record.DevServers...), CheckedAt: record.CheckedAt,
	}
	if record.Handle.Process != nil && record.Handle.Process.PID > 0 && record.State != StateStopped && record.State != StateCleaning && record.State != StateFailed {
		result.PID = valuePointer(record.Handle.Process.PID)
	}
	if record.StartedAt != "" {
		result.StartedAt = valuePointer(record.StartedAt)
	}
	if failure != nil {
		result.LastError = valuePointer(failure.Error())
	} else if record.LastError != "" {
		result.LastError = valuePointer(record.LastError)
	}
	if result.DevServers == nil {
		result.DevServers = []ManagedDevServer{}
	}
	return result
}

func (manager *Manager) timestamp() string {
	return manager.now().UTC().Format(time.RFC3339Nano)
}

func valuePointer[T any](value T) *T { return &value }

func activeState(state RuntimeState) bool {
	return state == StateStarting || state == StateRunning || state == StateSuspending || state == StateSuspended || state == StateResuming || state == StateStopping || state == StateCleaning
}

func verifyGeneration(record runtimeRecord, expected string) error {
	if expected != "" && record.Generation != expected {
		return fmt.Errorf("runtime generation mismatch: expected %s, received %s", expected, record.Generation)
	}
	return nil
}

func verifyStoredBinding(record runtimeRecord, options OperationOptions) error {
	if err := verifyGeneration(record, options.ExpectedGeneration); err != nil {
		return err
	}
	if options.ExpectedWorkspaceID != "" && record.WorkspaceID != options.ExpectedWorkspaceID {
		return fmt.Errorf("runtime Workspace identity mismatch")
	}
	if options.ExpectedBranch != "" && record.Branch != options.ExpectedBranch {
		return fmt.Errorf("stored Workspace branch mismatch")
	}
	if options.ExpectedCommit != "" && record.Head != options.ExpectedCommit {
		return fmt.Errorf("runtime source HEAD mismatch")
	}
	if options.ExpectedDigest != "" && record.ManifestDigest != options.ExpectedDigest {
		return fmt.Errorf("runtime manifest digest mismatch")
	}
	if options.Mode != "" && record.Mode != options.Mode {
		return fmt.Errorf("runtime mode mismatch")
	}
	return nil
}

func requireExpectedGeneration(options OperationOptions) error {
	if strings.TrimSpace(options.ExpectedGeneration) == "" {
		return fmt.Errorf("expected runtime generation is required for this mutating operation")
	}
	return nil
}

func sameActivePlan(record runtimeRecord, plan resolvedPlan) bool {
	return record.WorkspaceID == plan.Identity.WorkspaceID && record.ManifestDigest == plan.Digest &&
		record.Head == plan.Identity.Head && record.Mode == plan.Mode && record.Directory == plan.Identity.Directory
}

func exactServer(record runtimeRecord, observed projectrun.ServeResult, expected ManagedDevServer) error {
	if observed.WorkspaceID != record.WorkspaceID || observed.RuntimeGeneration != record.Generation ||
		observed.ServerID != expected.ServerID ||
		(expected.ServerGeneration != "" && observed.ServerGeneration != expected.ServerGeneration) ||
		observed.TmuxSession != expected.TmuxSession ||
		(observed.State != projectrun.StateRunning && observed.State != projectrun.StateLocalOnly) ||
		observed.LastError != nil {
		return fmt.Errorf("dev server %q ownership no longer matches Workspace generation", expected.Name)
	}
	return nil
}

func serverFromResult(name string, result projectrun.ServeResult) ManagedDevServer {
	return ManagedDevServer{
		Name: name, ServerID: result.ServerID, ServerGeneration: result.ServerGeneration,
		TmuxSession: result.TmuxSession,
		State:       string(result.State), LocalPort: result.LocalPort, LocalURL: result.LocalURL,
	}
}

func mergeErrors(failures ...error) error {
	filtered := failures[:0]
	for _, failure := range failures {
		if failure != nil {
			filtered = append(filtered, failure)
		}
	}
	return errors.Join(filtered...)
}
