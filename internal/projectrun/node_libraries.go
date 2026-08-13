package projectrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
)

const (
	localNodeLibrariesManifestVersion = 1
	maximumLocalNodeLibraries         = 16
	maximumLocalNodePackages          = 256
)

var nodePackageNamePattern = regexp.MustCompile(`^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`)

type LocalNodeLibrary struct {
	Directory        string             `json:"directory"`
	Repository       string             `json:"repository"`
	Branch           string             `json:"branch"`
	Revision         string             `json:"revision"`
	Dirty            bool               `json:"dirty"`
	Packages         []LocalNodePackage `json:"packages"`
	CompanionServers []string           `json:"companionServers"`
}

type LocalNodePackage struct {
	Name              string            `json:"name"`
	Directory         string            `json:"directory"`
	Mode              string            `json:"mode"`
	WatchCommand      []string          `json:"watchCommand,omitempty"`
	Imports           []LocalNodeImport `json:"imports"`
	SourceDirectories []string          `json:"sourceDirectories"`
}

type LocalNodeImport struct {
	Specifier string `json:"specifier"`
	Path      string `json:"path"`
}

type localNodeLibrariesManifest struct {
	Version   int                `json:"version"`
	Libraries []LocalNodeLibrary `json:"libraries"`
}

func sameLocalNodeLibraryBindings(first, second []LocalNodeLibrary) bool {
	return reflect.DeepEqual(localNodeLibraryBindings(first), localNodeLibraryBindings(second))
}

func localNodeLibraryBindings(libraries []LocalNodeLibrary) []LocalNodeLibrary {
	bindings := make([]LocalNodeLibrary, len(libraries))
	for index, library := range libraries {
		bindings[index] = LocalNodeLibrary{
			Directory:        library.Directory,
			Repository:       library.Repository,
			Packages:         library.Packages,
			CompanionServers: library.CompanionServers,
		}
	}
	return bindings
}

type nodePackageJSON struct {
	Name       string            `json:"name"`
	Private    bool              `json:"private"`
	Workspaces json.RawMessage   `json:"workspaces"`
	Exports    any               `json:"exports"`
	Source     string            `json:"source"`
	Scripts    map[string]string `json:"scripts"`
}

func discoverLocalNodeLibraries(
	ctx context.Context,
	consumerRoot string,
	values []string,
) ([]LocalNodeLibrary, error) {
	if len(values) == 0 {
		return nil, nil
	}
	if len(values) > maximumLocalNodeLibraries {
		return nil, fmt.Errorf("--with may be repeated at most %d times", maximumLocalNodeLibraries)
	}
	consumer, err := canonicalDirectory(consumerRoot)
	if err != nil {
		return nil, err
	}
	libraries := make([]LocalNodeLibrary, 0, len(values))
	seenDirectories := map[string]bool{}
	packageOwners := map[string]string{}
	for _, value := range values {
		library, err := discoverLocalNodeLibrary(ctx, value)
		if err != nil {
			return nil, fmt.Errorf("inspect --with %q: %w", value, err)
		}
		if library.Directory == consumer {
			return nil, fmt.Errorf("--with %q resolves to the consumer worktree itself", value)
		}
		if seenDirectories[library.Directory] {
			continue
		}
		seenDirectories[library.Directory] = true
		for _, pkg := range library.Packages {
			if owner, exists := packageOwners[pkg.Name]; exists {
				return nil, fmt.Errorf(
					"local package %q is provided by both %s and %s",
					pkg.Name, owner, library.Directory,
				)
			}
			packageOwners[pkg.Name] = library.Directory
		}
		libraries = append(libraries, library)
	}
	sort.Slice(libraries, func(i, j int) bool { return libraries[i].Directory < libraries[j].Directory })
	return libraries, nil
}

func discoverLocalNodeLibrary(ctx context.Context, value string) (LocalNodeLibrary, error) {
	directory, err := canonicalDirectory(value)
	if err != nil {
		return LocalNodeLibrary{}, err
	}
	repository, err := gitOutput(ctx, directory, "rev-parse", "--show-toplevel")
	if err != nil {
		return LocalNodeLibrary{}, fmt.Errorf("path is not inside a Git worktree: %w", err)
	}
	repository, err = canonicalDirectory(repository)
	if err != nil {
		return LocalNodeLibrary{}, err
	}
	revision, err := gitOutput(ctx, repository, "rev-parse", "HEAD")
	if err != nil {
		return LocalNodeLibrary{}, fmt.Errorf("resolve Git revision: %w", err)
	}
	branch, err := gitOutput(ctx, repository, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		branch = "HEAD"
	}
	status, statusErr := gitOutput(ctx, repository, "status", "--porcelain=v1", "--untracked-files=normal")
	if statusErr != nil {
		return LocalNodeLibrary{}, fmt.Errorf("inspect Git status: %w", statusErr)
	}
	packages, err := discoverWorkspacePackages(repository)
	if err != nil {
		return LocalNodeLibrary{}, err
	}
	if len(packages) == 0 {
		return LocalNodeLibrary{}, fmt.Errorf("no Node packages with exports were found")
	}
	companionServers := []string{}
	if declaration, declarationErr := LoadDeclaration(repository); declarationErr == nil {
		for name, server := range declaration.Server {
			if server.PrototypeSurface != "" {
				companionServers = append(companionServers, name)
			}
		}
		sort.Strings(companionServers)
	}
	return LocalNodeLibrary{
		Directory: repository, Repository: repository, Branch: branch, Revision: revision,
		Dirty: status != "", Packages: packages, CompanionServers: companionServers,
	}, nil
}

func gitOutput(ctx context.Context, directory string, arguments ...string) (string, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", directory}, arguments...)...)
	body, err := command.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(body)), nil
}

func discoverWorkspacePackages(repository string) ([]LocalNodePackage, error) {
	rootManifest, err := readNodePackageJSON(filepath.Join(repository, "package.json"))
	if err != nil {
		return nil, fmt.Errorf("read Node workspace root: %w", err)
	}
	patterns, err := parseWorkspacePatterns(rootManifest.Workspaces)
	if err != nil {
		return nil, err
	}
	directories := []string{repository}
	for _, pattern := range patterns {
		matches, globErr := filepath.Glob(filepath.Join(repository, filepath.FromSlash(pattern)))
		if globErr != nil {
			return nil, fmt.Errorf("workspace pattern %q is invalid: %w", pattern, globErr)
		}
		directories = append(directories, matches...)
	}
	seen := map[string]bool{}
	packages := []LocalNodePackage{}
	for _, candidate := range directories {
		canonical, canonicalErr := canonicalDirectory(candidate)
		if canonicalErr != nil || seen[canonical] {
			continue
		}
		seen[canonical] = true
		manifest, manifestErr := readNodePackageJSON(filepath.Join(canonical, "package.json"))
		if errors.Is(manifestErr, os.ErrNotExist) {
			continue
		}
		if manifestErr != nil {
			return nil, fmt.Errorf("read package in %s: %w", canonical, manifestErr)
		}
		pkg, include, packageErr := localNodePackageFromManifest(canonical, manifest)
		if packageErr != nil {
			return nil, packageErr
		}
		if include {
			packages = append(packages, pkg)
		}
		if len(packages) > maximumLocalNodePackages {
			return nil, fmt.Errorf("Node workspace contains more than %d exported packages", maximumLocalNodePackages)
		}
	}
	sort.Slice(packages, func(i, j int) bool { return packages[i].Name < packages[j].Name })
	return packages, nil
}

func readNodePackageJSON(path string) (nodePackageJSON, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nodePackageJSON{}, err
	}
	if len(body) > 1<<20 {
		return nodePackageJSON{}, fmt.Errorf("%s exceeds the 1 MiB limit", path)
	}
	manifest := nodePackageJSON{}
	if err := json.Unmarshal(body, &manifest); err != nil {
		return nodePackageJSON{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return manifest, nil
}

func parseWorkspacePatterns(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return []string{}, nil
	}
	patterns := []string{}
	if err := json.Unmarshal(raw, &patterns); err == nil {
		return validatedWorkspacePatterns(patterns)
	}
	object := struct {
		Packages []string `json:"packages"`
	}{}
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, fmt.Errorf("package.json workspaces must be an array or an object with packages")
	}
	return validatedWorkspacePatterns(object.Packages)
}

func validatedWorkspacePatterns(patterns []string) ([]string, error) {
	result := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		if pattern == "" || filepath.IsAbs(pattern) || strings.HasPrefix(pattern, "!") ||
			strings.Contains(pattern, "..") || strings.ContainsRune(pattern, '\x00') {
			return nil, fmt.Errorf("workspace pattern %q is not supported", pattern)
		}
		result = append(result, filepath.ToSlash(filepath.Clean(pattern)))
	}
	return result, nil
}

func localNodePackageFromManifest(
	directory string,
	manifest nodePackageJSON,
) (LocalNodePackage, bool, error) {
	if manifest.Name == "" || manifest.Exports == nil {
		return LocalNodePackage{}, false, nil
	}
	if !nodePackageNamePattern.MatchString(manifest.Name) {
		return LocalNodePackage{}, false, fmt.Errorf("package %q in %s has an unsupported name", manifest.Name, directory)
	}
	entries := exportEntries(manifest.Exports)
	imports := make([]LocalNodeImport, 0, len(entries))
	sourceCount := 0
	for subpath, definition := range entries {
		if strings.Contains(subpath, "*") {
			continue
		}
		target := preferredExportTarget(definition)
		if target == "" {
			continue
		}
		resolved, source := resolveLocalExport(directory, subpath, target, manifest.Source)
		if resolved == "" {
			continue
		}
		specifier := manifest.Name
		if subpath != "." {
			specifier += "/" + strings.TrimPrefix(subpath, "./")
		}
		imports = append(imports, LocalNodeImport{Specifier: specifier, Path: resolved})
		if source {
			sourceCount++
		}
	}
	if len(imports) == 0 {
		return LocalNodePackage{}, false, nil
	}
	sort.Slice(imports, func(i, j int) bool { return imports[i].Specifier < imports[j].Specifier })
	sourceDirectories := []string{}
	sourceRoot := filepath.Join(directory, "src")
	if info, err := os.Stat(sourceRoot); err == nil && info.IsDir() {
		sourceDirectories = append(sourceDirectories, sourceRoot)
	}
	mode := "watch"
	watchCommand := []string(nil)
	if sourceCount > 0 {
		mode = "source"
	} else {
		watchScript := localNodeWatchScript(manifest.Scripts)
		if watchScript == "" {
			return LocalNodePackage{}, false, fmt.Errorf(
				"package %q exports built files but declares no watch, build:watch, or dev:watch script",
				manifest.Name,
			)
		}
		watchCommand = []string{"bun", "run", watchScript}
	}
	return LocalNodePackage{
		Name: manifest.Name, Directory: directory, Mode: mode,
		WatchCommand: watchCommand, Imports: imports, SourceDirectories: sourceDirectories,
	}, true, nil
}

func localNodeWatchScript(scripts map[string]string) string {
	for _, name := range []string{"watch", "build:watch", "dev:watch"} {
		if strings.TrimSpace(scripts[name]) != "" {
			return name
		}
	}
	return ""
}

func exportEntries(exports any) map[string]any {
	if value, ok := exports.(string); ok {
		return map[string]any{".": value}
	}
	object, ok := exports.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	for key := range object {
		if strings.HasPrefix(key, ".") {
			return object
		}
	}
	return map[string]any{".": object}
}

func preferredExportTarget(value any) string {
	switch candidate := value.(type) {
	case string:
		if strings.HasPrefix(candidate, "./") {
			return candidate
		}
	case []any:
		for _, entry := range candidate {
			if target := preferredExportTarget(entry); target != "" {
				return target
			}
		}
	case map[string]any:
		for _, condition := range []string{"development", "source", "import", "default", "browser"} {
			if target := preferredExportTarget(candidate[condition]); target != "" {
				return target
			}
		}
	}
	return ""
}

func resolveLocalExport(directory, subpath, target, sourceField string) (string, bool) {
	candidates := []string{}
	if subpath == "." && strings.HasPrefix(sourceField, "./") {
		candidates = append(candidates, strings.TrimPrefix(sourceField, "./"))
	}
	subpathValue := strings.TrimPrefix(subpath, "./")
	if subpath == "." {
		subpathValue = "index"
	}
	if filepath.Ext(subpathValue) != "" {
		candidates = append(candidates, filepath.Join("src", subpathValue))
	} else {
		for _, suffix := range []string{".ts", ".tsx", ".js", ".jsx"} {
			candidates = append(candidates, filepath.Join("src", subpathValue+suffix))
		}
		for _, name := range []string{"index.ts", "index.tsx", "index.js", "index.jsx"} {
			candidates = append(candidates, filepath.Join("src", subpathValue, name))
		}
	}
	targetValue := strings.TrimPrefix(target, "./")
	if strings.HasPrefix(targetValue, "dist/") {
		derived := "src/" + strings.TrimPrefix(targetValue, "dist/")
		for _, extension := range []string{".js", ".mjs", ".cjs"} {
			if strings.HasSuffix(derived, extension) {
				derived = strings.TrimSuffix(derived, extension)
				candidates = append(candidates, derived+".ts", derived+".tsx", derived+".js", derived+".jsx")
			}
		}
		candidates = append(candidates, derived)
	}
	for _, candidate := range append(candidates, targetValue) {
		path := filepath.Join(directory, filepath.FromSlash(candidate))
		info, err := os.Stat(path)
		if err == nil && info.Mode().IsRegular() {
			relative, _ := filepath.Rel(directory, path)
			return path, relative == "src" || strings.HasPrefix(relative, "src"+string(filepath.Separator))
		}
	}
	return "", false
}
