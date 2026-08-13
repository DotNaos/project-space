package workspacerun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/DotNaos/project-space/internal/worktreeownership"
)

// LaunchPlan is the trusted, read-only description needed to launch one exact
// Workspace Runtime from a Project-managed worktree.
type LaunchPlan struct {
	Branch                string
	Commit                string
	Directory             string
	ManifestDigest        string
	Mode                  Mode
	RuntimeVersion        string
	WorkspaceID           string
	WorktreeOwnerThreadID string
}

type resolvedPlan struct {
	Resolution  ManifestResolution
	Identity    WorkspaceIdentity
	Declaration projectrun.Declaration
	Mode        Mode
	Digest      string
}

type digestPlan struct {
	SchemaVersion      int           `json:"schemaVersion"`
	Head               string        `json:"head"`
	Mode               Mode          `json:"mode"`
	ManifestDigest     string        `json:"manifestDigest"`
	ScriptsDigest      string        `json:"scriptsDigest"`
	DevcontainerDigest string        `json:"devcontainerDigest,omitempty"`
	Manifest           Manifest      `json:"manifest"`
	Inputs             []digestInput `json:"inputs"`
}

type digestInput struct {
	Path   string `json:"path"`
	Digest string `json:"digest"`
}

// ResolveLaunchPlan derives the launch binding from the current managed
// worktree without creating or mutating runtime state.
func ResolveLaunchPlan(ctx context.Context, directory string, requested Mode) (LaunchPlan, error) {
	plan, err := resolvePlan(ctx, GitIdentityResolver{}, directory, requested)
	if err != nil {
		return LaunchPlan{}, err
	}
	managed, err := worktreeownership.InspectManaged(plan.Identity.Directory)
	if err != nil {
		return LaunchPlan{}, err
	}
	if managed.Path != plan.Identity.Directory || managed.Branch != plan.Identity.Branch ||
		managed.WorkspaceID != plan.Identity.WorkspaceID {
		return LaunchPlan{}, fmt.Errorf("managed Worktree inspection resolved a different checkout")
	}
	if plan.Identity.Owner != "" && managed.Owner != plan.Identity.Owner {
		return LaunchPlan{}, fmt.Errorf("managed Worktree belongs to a different Codex task")
	}
	if plan.Identity.Dirty {
		return LaunchPlan{}, fmt.Errorf("Workspace checkout must be clean before runtime launch")
	}
	return LaunchPlan{
		Branch: plan.Identity.Branch, Commit: plan.Identity.Head, Directory: plan.Identity.Directory,
		ManifestDigest: plan.Digest, Mode: plan.Mode,
		RuntimeVersion: plan.Resolution.Manifest.ProjectRuntime.Version,
		WorkspaceID:    plan.Identity.WorkspaceID, WorktreeOwnerThreadID: managed.Owner,
	}, nil
}

func resolvePlan(ctx context.Context, resolver IdentityResolver, directory string, requested Mode) (resolvedPlan, error) {
	resolution, err := LoadManifest(directory)
	if err != nil {
		return resolvedPlan{}, err
	}
	identity, err := resolver.Resolve(ctx, resolution.Directory)
	if err != nil {
		return resolvedPlan{}, err
	}
	mode := requested
	if mode == "" {
		mode = resolution.Manifest.DefaultMode
	}
	if mode != ModeProcess && mode != ModeDevcontainer {
		return resolvedPlan{}, fmt.Errorf("runtime mode must be process or devcontainer")
	}
	if mode == ModeProcess && !resolution.Manifest.Resources.Empty() {
		return resolvedPlan{}, fmt.Errorf("process mode cannot enforce positive resource limits")
	}
	if mode == ModeDevcontainer && resolution.Manifest.Devcontainer == nil {
		return resolvedPlan{}, fmt.Errorf("devcontainer mode requires a devcontainer declaration")
	}
	declaration, err := projectrun.LoadDeclaration(resolution.Directory)
	if err != nil {
		return resolvedPlan{}, err
	}
	if err := validateReferences(resolution.Manifest, declaration); err != nil {
		return resolvedPlan{}, err
	}
	containerDigest := ""
	if resolution.Manifest.Devcontainer != nil {
		path := filepath.Join(resolution.Directory, resolution.Manifest.Devcontainer.Path)
		containerDigest, err = regularFileDigest(path)
		if err != nil {
			return resolvedPlan{}, err
		}
	}
	inputs := make([]digestInput, 0, len(resolution.Manifest.Inputs))
	for _, input := range resolution.Manifest.Inputs {
		digest, err := regularFileDigest(filepath.Join(resolution.Directory, input))
		if err != nil {
			return resolvedPlan{}, fmt.Errorf("digest input %q: %w", input, err)
		}
		inputs = append(inputs, digestInput{Path: input, Digest: digest})
	}
	encoded, err := json.Marshal(digestPlan{
		SchemaVersion: SchemaVersion, Head: identity.Head, Mode: mode,
		ManifestDigest: resolution.Digest, ScriptsDigest: declaration.Digest,
		DevcontainerDigest: containerDigest, Manifest: resolution.Manifest, Inputs: inputs,
	})
	if err != nil {
		return resolvedPlan{}, fmt.Errorf("encode resolved runtime plan: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return resolvedPlan{
		Resolution: resolution, Identity: identity, Declaration: declaration, Mode: mode,
		Digest: hex.EncodeToString(digest[:]),
	}, nil
}

func validateReferences(manifest Manifest, declaration projectrun.Declaration) error {
	for _, name := range manifest.Setup {
		if _, err := declaration.SetupStep(name); err != nil {
			return fmt.Errorf("runtime setup reference %q: %w", name, err)
		}
	}
	for _, name := range manifest.Startup {
		if _, ok := declaration.Command[name]; !ok {
			return fmt.Errorf("runtime startup reference %q is not a finite command in .project/scripts.yaml", name)
		}
	}
	for _, name := range manifest.Shutdown {
		if _, ok := declaration.Command[name]; !ok {
			return fmt.Errorf("runtime shutdown reference %q is not a finite command in .project/scripts.yaml", name)
		}
	}
	for _, name := range manifest.DevServers {
		if _, ok := declaration.Server[name]; !ok {
			return fmt.Errorf("runtime devServer reference %q is not a server in .project/scripts.yaml", name)
		}
	}
	return nil
}

func regularFileDigest(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", fmt.Errorf("must be a regular file, not a symlink")
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:]), nil
}
