package workspacerun

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

const manifestPath = ".project/runtime.yaml"

var declarationNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)
var exactVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9][A-Za-z0-9.-]*)?$`)
var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var workspaceIDPattern = regexp.MustCompile(`^(?:ws_[a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$`)
var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var tokenPattern = uuidPattern
var filesystemIdentityPattern = regexp.MustCompile(`^[a-f0-9]+:[a-f0-9]+$`)

func LoadManifest(directory string) (ManifestResolution, error) {
	root, err := canonicalDirectory(directory)
	if err != nil {
		return ManifestResolution{}, err
	}
	path := filepath.Join(root, manifestPath)
	info, err := os.Lstat(path)
	if err != nil {
		return ManifestResolution{Directory: root, Path: path}, fmt.Errorf("inspect %s: %w", manifestPath, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return ManifestResolution{Directory: root, Path: path}, fmt.Errorf("%s must be a regular file, not a symlink", manifestPath)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return ManifestResolution{Directory: root, Path: path}, fmt.Errorf("read %s: %w", manifestPath, err)
	}
	if len(body) > 1<<20 {
		return ManifestResolution{Directory: root, Path: path}, fmt.Errorf("%s exceeds the 1 MiB limit", manifestPath)
	}
	manifest := Manifest{}
	decoder := yaml.NewDecoder(strings.NewReader(string(body)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&manifest); err != nil {
		return ManifestResolution{Directory: root, Path: path}, fmt.Errorf("parse %s: %w", manifestPath, err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			err = fmt.Errorf("multiple YAML documents are not supported")
		}
		return ManifestResolution{Directory: root, Path: path}, fmt.Errorf("parse %s: %w", manifestPath, err)
	}
	if err := validateManifest(root, manifest); err != nil {
		return ManifestResolution{Directory: root, Path: path}, fmt.Errorf("validate %s: %w", manifestPath, err)
	}
	digest := sha256.Sum256(body)
	return ManifestResolution{
		Directory: root,
		Path:      path,
		Digest:    hex.EncodeToString(digest[:]),
		Manifest:  manifest,
	}, nil
}

func validateManifest(root string, manifest Manifest) error {
	if manifest.Version != SchemaVersion {
		return fmt.Errorf("version must be %d", SchemaVersion)
	}
	if manifest.DefaultMode != ModeProcess && manifest.DefaultMode != ModeDevcontainer {
		return fmt.Errorf("defaultMode must be process or devcontainer")
	}
	if manifest.CredentialScope != CredentialScopeWorkspaceGeneration {
		return fmt.Errorf("credentialScope must be %s", CredentialScopeWorkspaceGeneration)
	}
	if manifest.ProjectProtocol != SupportedProjectProtocol {
		return fmt.Errorf("projectProtocol must be %d", SupportedProjectProtocol)
	}
	if manifest.ProjectRuntime.ID != ToolProject {
		return fmt.Errorf("projectRuntime.id must be %s", ToolProject)
	}
	if manifest.Codex.ID != ToolCodex {
		return fmt.Errorf("codex.id must be %s", ToolCodex)
	}
	if err := validateToolPin("projectRuntime", manifest.ProjectRuntime); err != nil {
		return err
	}
	if err := validateToolPin("codex", manifest.Codex); err != nil {
		return err
	}
	if len(manifest.Toolchains) > 32 {
		return fmt.Errorf("toolchains must contain at most 32 entries")
	}
	toolIDs := map[ToolID]bool{manifest.ProjectRuntime.ID: true, manifest.Codex.ID: true}
	for index, tool := range manifest.Toolchains {
		if err := validateToolPin(fmt.Sprintf("toolchains[%d]", index), tool); err != nil {
			return err
		}
		if toolIDs[tool.ID] {
			return fmt.Errorf("tool id %q is duplicated", tool.ID)
		}
		toolIDs[tool.ID] = true
	}
	for label, names := range map[string][]string{
		"setup": manifest.Setup, "startup": manifest.Startup, "shutdown": manifest.Shutdown,
		"devServers": manifest.DevServers,
	} {
		if err := validateNames(label, names); err != nil {
			return err
		}
	}
	servers := make(map[string]bool, len(manifest.DevServers))
	for _, name := range manifest.DevServers {
		servers[name] = true
	}
	if len(manifest.Inputs) > 64 {
		return fmt.Errorf("inputs must contain at most 64 entries")
	}
	inputPaths := map[string]bool{}
	for _, input := range manifest.Inputs {
		if inputPaths[input] {
			return fmt.Errorf("input %q is duplicated", input)
		}
		inputPaths[input] = true
		if _, err := validateRelativeFile(root, input); err != nil {
			return fmt.Errorf("input %q: %w", input, err)
		}
	}
	if len(manifest.Ports) > 64 {
		return fmt.Errorf("ports must contain at most 64 entries")
	}
	portIDs := map[string]bool{}
	for _, port := range manifest.Ports {
		if !declarationNamePattern.MatchString(port.ID) {
			return fmt.Errorf("port id %q is invalid", port.ID)
		}
		if portIDs[port.ID] {
			return fmt.Errorf("port id %q is duplicated", port.ID)
		}
		portIDs[port.ID] = true
		if port.Protocol != "tcp" {
			return fmt.Errorf("port %q protocol must be tcp", port.ID)
		}
		if !servers[port.DevServer] {
			return fmt.Errorf("port %q references unknown devServer %q", port.ID, port.DevServer)
		}
	}
	if manifest.Resources.CPUMillis < 0 || manifest.Resources.CPUMillis > 256_000 {
		return fmt.Errorf("resources.cpuMillis must be between 0 and 256000")
	}
	if manifest.Resources.MemoryMiB < 0 || manifest.Resources.MemoryMiB > 1<<20 {
		return fmt.Errorf("resources.memoryMiB must be between 0 and 1048576")
	}
	if manifest.Resources.PIDs < 0 || manifest.Resources.PIDs > 1<<20 {
		return fmt.Errorf("resources.pids must be between 0 and 1048576")
	}
	if manifest.DefaultMode == ModeProcess && !manifest.Resources.Empty() {
		return fmt.Errorf("positive resource limits are unsupported in process mode")
	}
	if manifest.DefaultMode == ModeDevcontainer && manifest.Devcontainer == nil {
		return fmt.Errorf("devcontainer is required when defaultMode is devcontainer")
	}
	if manifest.Devcontainer != nil {
		path, err := validateRelativeFile(root, manifest.Devcontainer.Path)
		if err != nil {
			return fmt.Errorf("devcontainer.path: %w", err)
		}
		if err := validateDevcontainer(path); err != nil {
			return fmt.Errorf("devcontainer.path: %w", err)
		}
	}
	return nil
}

func validateToolPin(label string, pin ToolPin) error {
	if !supportedTool(pin.ID) {
		return fmt.Errorf("%s.id %q is unsupported", label, pin.ID)
	}
	if !exactVersionPattern.MatchString(pin.Version) {
		return fmt.Errorf("%s.version must be an exact semantic version", label)
	}
	if !sha256Pattern.MatchString(pin.SHA256) {
		return fmt.Errorf("%s.sha256 must be a lowercase SHA-256 digest", label)
	}
	return nil
}

func supportedTool(id ToolID) bool {
	switch id {
	case ToolProject, ToolCodex, ToolBun, ToolNode, ToolGo, ToolPython, ToolRust:
		return true
	default:
		return false
	}
}

func validateNames(label string, names []string) error {
	if len(names) > 64 {
		return fmt.Errorf("%s must contain at most 64 entries", label)
	}
	seen := map[string]bool{}
	for _, name := range names {
		if !declarationNamePattern.MatchString(name) {
			return fmt.Errorf("%s name %q is invalid", label, name)
		}
		if seen[name] {
			return fmt.Errorf("%s name %q is duplicated", label, name)
		}
		seen[name] = true
	}
	return nil
}

func validateRelativeFile(root, candidate string) (string, error) {
	if candidate == "" || filepath.IsAbs(candidate) || filepath.Clean(candidate) != candidate || candidate == ".." || strings.HasPrefix(candidate, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("must be a clean repository-relative path")
	}
	path := filepath.Join(root, candidate)
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", fmt.Errorf("must name a regular file, not a symlink")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("must resolve inside the Workspace")
	}
	info, err = os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("must name a regular file")
	}
	return resolved, nil
}

func canonicalDirectory(directory string) (string, error) {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%q is not a directory", resolved)
	}
	return filepath.Clean(resolved), nil
}
