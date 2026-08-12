package workspacerun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/DotNaos/project-space/internal/projectrun"
)

type processRunner interface {
	StartDetachedWithOutput(projectrun.Command, *os.File, projectrun.ProcessCommit) (projectrun.ProcessRef, error)
	Alive(projectrun.ProcessRef) bool
	PIDExists(int) bool
	Suspended(projectrun.ProcessRef) (bool, error)
	SuspendGroup(projectrun.ProcessRef) error
	ResumeGroup(projectrun.ProcessRef) error
	StopGroup(projectrun.ProcessRef, time.Duration) error
	OwnsUnixSocket(projectrun.ProcessRef, string) (bool, error)
}

type ProcessProvider struct {
	Runner processRunner
}

func (ProcessProvider) Mode() Mode { return ModeProcess }

func (provider ProcessProvider) Start(_ context.Context, request LaunchRequest) (RuntimeHandle, error) {
	if err := validateRuntimeBinding(request.Binding); err != nil {
		return RuntimeHandle{}, err
	}
	if !request.Manifest.Resources.Empty() {
		return RuntimeHandle{}, fmt.Errorf("process mode cannot enforce positive resource limits")
	}
	if request.ProjectBinary == "" {
		return RuntimeHandle{}, fmt.Errorf("verified Project CLI path is required")
	}
	if request.CodexBinary == "" {
		return RuntimeHandle{}, fmt.Errorf("verified Codex CLI path is required")
	}
	if request.LogFile == nil {
		return RuntimeHandle{}, fmt.Errorf("anchored Workspace runtime log is required")
	}
	for _, directory := range []string{
		request.GenerationHome,
		filepath.Join(request.GenerationHome, "home"),
		filepath.Join(request.GenerationHome, "config"),
		filepath.Join(request.GenerationHome, "data"),
		filepath.Join(request.GenerationHome, "cache"),
		filepath.Join(request.GenerationHome, "codex"),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return RuntimeHandle{}, fmt.Errorf("create generation-scoped runtime directory: %w", err)
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			return RuntimeHandle{}, fmt.Errorf("protect generation-scoped runtime directory: %w", err)
		}
	}
	runner := provider.Runner
	if runner == nil {
		runner = projectrun.OSProcessRunner{SupervisorExecutable: request.ProjectBinary}
	}
	appServerSocket := appServerSocketPath(request.Binding)
	if _, err := os.Lstat(appServerSocket); err == nil {
		return RuntimeHandle{}, fmt.Errorf("private Codex app-server socket path is already occupied")
	} else if !os.IsNotExist(err) {
		return RuntimeHandle{}, fmt.Errorf("inspect private Codex app-server socket: %w", err)
	}
	command := projectrun.Command{
		Argv:       []string{request.CodexBinary, "app-server", "--listen", "unix://" + appServerSocket, "--strict-config"},
		Dir:        request.Directory,
		Env:        generationEnvironment(request.GenerationHome, request.Binding),
		InheritEnv: false,
	}
	process, err := runner.StartDetachedWithOutput(command, request.LogFile, func(process projectrun.ProcessRef) error {
		handle := RuntimeHandle{Kind: ResourceProcess, Process: processHandle(process, request.Binding, appServerSocket)}
		return request.Commit(handle)
	})
	if err != nil {
		return RuntimeHandle{}, err
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		owned, inspectErr := runner.OwnsUnixSocket(process, appServerSocket)
		if inspectErr != nil {
			_ = runner.StopGroup(process, time.Second)
			return RuntimeHandle{}, inspectErr
		}
		if owned {
			break
		}
		if !runner.Alive(process) || time.Now().After(deadline) {
			_ = runner.StopGroup(process, time.Second)
			return RuntimeHandle{}, fmt.Errorf("pinned Codex app-server did not acquire its private socket")
		}
		time.Sleep(25 * time.Millisecond)
	}
	return RuntimeHandle{Kind: ResourceProcess, Process: processHandle(process, request.Binding, appServerSocket)}, nil
}

func appServerSocketPath(binding RuntimeBinding) string {
	digest := sha256.Sum256([]byte("project-codex-app-server\x00" + bindingDigest(binding)))
	return filepath.Join(os.TempDir(), "project-codex-"+hex.EncodeToString(digest[:12])+".sock")
}

func processHandle(process projectrun.ProcessRef, binding RuntimeBinding, appServerSocket string) *ProcessHandle {
	return &ProcessHandle{PID: process.PID, Identity: process.Identity, BindingDigest: bindingDigest(binding), AppServerSocket: appServerSocket}
}

func bindingDigest(binding RuntimeBinding) string {
	value := binding.WorkspaceID + "\x00" + binding.Generation + "\x00" + binding.ManifestDigest + "\x00" + binding.OwnershipToken
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func generationEnvironment(home string, binding RuntimeBinding) []string {
	return []string{
		"PROJECT_WORKSPACE_ID=" + binding.WorkspaceID,
		"PROJECT_RUNTIME_GENERATION=" + binding.Generation,
		"PROJECT_RUNTIME_MANIFEST_DIGEST=" + binding.ManifestDigest,
		"PROJECT_RUNTIME_OWNERSHIP_TOKEN=" + binding.OwnershipToken,
		"HOME=" + filepath.Join(home, "home"),
		"XDG_CONFIG_HOME=" + filepath.Join(home, "config"),
		"XDG_DATA_HOME=" + filepath.Join(home, "data"),
		"XDG_CACHE_HOME=" + filepath.Join(home, "cache"),
		"CODEX_HOME=" + filepath.Join(home, "codex"),
	}
}

func (provider ProcessProvider) Inspect(_ context.Context, handle RuntimeHandle, binding RuntimeBinding) (ProviderObservation, error) {
	if err := validateRuntimeBinding(binding); err != nil {
		return ProviderObservation{}, err
	}
	if handle.Process == nil || handle.Process.BindingDigest != bindingDigest(binding) {
		return ProviderObservation{}, fmt.Errorf("process runtime binding proof changed")
	}
	process, err := exactProcess(handle)
	if err != nil {
		return ProviderObservation{}, err
	}
	runner := provider.Runner
	if runner == nil {
		runner = projectrun.OSProcessRunner{}
	}
	exists := runner.Alive(process)
	if !exists {
		return ProviderObservation{Exists: runner.PIDExists(process.PID), Owned: false, Handle: handle}, nil
	}
	ownedSocket, err := runner.OwnsUnixSocket(process, handle.Process.AppServerSocket)
	if err != nil {
		return ProviderObservation{}, err
	}
	if !ownedSocket {
		return ProviderObservation{Exists: true, Owned: false, Handle: handle}, nil
	}
	suspended, err := runner.Suspended(process)
	if err != nil {
		return ProviderObservation{}, err
	}
	return ProviderObservation{Exists: true, Owned: true, Running: !suspended, Suspended: suspended, Handle: handle}, nil
}

func (provider ProcessProvider) Suspend(_ context.Context, handle RuntimeHandle, binding RuntimeBinding) error {
	if err := validateRuntimeBinding(binding); err != nil {
		return err
	}
	process, err := exactProcess(handle)
	if err != nil {
		return err
	}
	runner := provider.Runner
	if runner == nil {
		runner = projectrun.OSProcessRunner{}
	}
	return runner.SuspendGroup(process)
}

func (provider ProcessProvider) Resume(_ context.Context, handle RuntimeHandle, binding RuntimeBinding) error {
	if err := validateRuntimeBinding(binding); err != nil {
		return err
	}
	process, err := exactProcess(handle)
	if err != nil {
		return err
	}
	runner := provider.Runner
	if runner == nil {
		runner = projectrun.OSProcessRunner{}
	}
	return runner.ResumeGroup(process)
}

func (provider ProcessProvider) Stop(_ context.Context, handle RuntimeHandle, binding RuntimeBinding, timeout time.Duration) error {
	if err := validateRuntimeBinding(binding); err != nil {
		return err
	}
	process, err := exactProcess(handle)
	if err != nil {
		return err
	}
	runner := provider.Runner
	if runner == nil {
		runner = projectrun.OSProcessRunner{}
	}
	return runner.StopGroup(process, timeout)
}

func (provider ProcessProvider) Clean(_ context.Context, handle RuntimeHandle, binding RuntimeBinding) error {
	if err := validateRuntimeBinding(binding); err != nil {
		return err
	}
	process, err := exactProcess(handle)
	if err != nil {
		return err
	}
	runner := provider.Runner
	if runner == nil {
		runner = projectrun.OSProcessRunner{}
	}
	if runner.Alive(process) {
		return fmt.Errorf("refusing to clean a live process runtime")
	}
	if runner.PIDExists(process.PID) {
		return fmt.Errorf("refusing to clean after the recorded PID changed ownership")
	}
	if _, err := os.Lstat(handle.Process.AppServerSocket); err == nil {
		return fmt.Errorf("refusing to clean while the recorded Codex app-server socket still exists")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect recorded Codex app-server socket: %w", err)
	}
	return nil
}

func validateRuntimeBinding(binding RuntimeBinding) error {
	if !workspaceIDPattern.MatchString(binding.WorkspaceID) || !uuidPattern.MatchString(binding.Generation) ||
		!sha256Pattern.MatchString(binding.ManifestDigest) || !tokenPattern.MatchString(binding.OwnershipToken) {
		return fmt.Errorf("runtime binding is invalid")
	}
	return nil
}

func exactProcess(handle RuntimeHandle) (projectrun.ProcessRef, error) {
	if handle.Kind != ResourceProcess || handle.Process == nil || handle.Container != nil || handle.Process.PID <= 0 || handle.Process.Identity == "" {
		return projectrun.ProcessRef{}, fmt.Errorf("process runtime handle is invalid")
	}
	return projectrun.ProcessRef{PID: handle.Process.PID, Identity: handle.Process.Identity}, nil
}
