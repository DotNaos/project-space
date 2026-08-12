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
	StartDetached(projectrun.Command, string, projectrun.ProcessCommit) (projectrun.ProcessRef, error)
	Alive(projectrun.ProcessRef) bool
	PIDExists(int) bool
	Suspended(projectrun.ProcessRef) (bool, error)
	SuspendGroup(projectrun.ProcessRef) error
	ResumeGroup(projectrun.ProcessRef) error
	StopGroup(projectrun.ProcessRef, time.Duration) error
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
	command := projectrun.Command{
		Argv:       []string{request.ProjectBinary, "__workspace-runtime-idle"},
		Dir:        request.Directory,
		Env:        generationEnvironment(request.GenerationHome, request.Binding),
		InheritEnv: false,
	}
	process, err := runner.StartDetached(command, request.LogPath, func(process projectrun.ProcessRef) error {
		handle := RuntimeHandle{Kind: ResourceProcess, Process: processHandle(process, request.Binding)}
		return request.Commit(handle)
	})
	if err != nil {
		return RuntimeHandle{}, err
	}
	return RuntimeHandle{Kind: ResourceProcess, Process: processHandle(process, request.Binding)}, nil
}

func processHandle(process projectrun.ProcessRef, binding RuntimeBinding) *ProcessHandle {
	return &ProcessHandle{PID: process.PID, Identity: process.Identity, BindingDigest: bindingDigest(binding)}
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
