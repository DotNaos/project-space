package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/DotNaos/project-space/internal/projectcatalog"
)

type localProjectDiscovery func(context.Context) (map[string][]string, error)

func discoverLocalProjectPaths(ctx context.Context) (map[string][]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, errors.New("resolve local projects root")
	}
	root := filepath.Join(home, "projects")
	entries, err := os.ReadDir(root)
	if os.IsNotExist(err) {
		return map[string][]string{}, nil
	}
	if err != nil {
		return nil, errors.New("inspect local projects root")
	}
	result := map[string][]string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		candidate := filepath.Join(root, entry.Name())
		canonical, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			continue
		}
		canonical, err = filepath.Abs(canonical)
		if err != nil {
			continue
		}
		topLevel, err := commandOutput(ctx, canonical, "git", "rev-parse", "--show-toplevel")
		if err != nil || filepath.Clean(strings.TrimSpace(topLevel)) != filepath.Clean(canonical) {
			continue
		}
		remote, err := commandOutput(ctx, canonical, "git", "remote", "get-url", "origin")
		if err != nil {
			continue
		}
		repository := githubRemoteRepository(strings.TrimSpace(remote))
		if repository == "" {
			continue
		}
		result[repository] = append(result[repository], canonical)
	}
	for repository := range result {
		sort.Strings(result[repository])
	}
	return result, nil
}

func mergedLocalProjectPaths(project projectcatalog.Project, discovered map[string][]string) []string {
	paths, _ := canonicalProjectPaths(project)
	seen := make(map[string]bool, len(paths))
	for _, path := range paths {
		seen[path] = true
	}
	for _, path := range discovered[strings.ToLower(project.Repository)] {
		if !seen[path] {
			paths = append(paths, path)
			seen[path] = true
		}
	}
	sort.Strings(paths)
	return paths
}

func loadLocalStorageProject(
	ctx context.Context,
	loader projectCatalogLoader,
	discover localProjectDiscovery,
	selector string,
) (projectcatalog.Project, string, error) {
	loaded, err := loadLiveProjectCatalog(ctx, projectCommandsDependencies{LoadCatalog: loader})
	if err != nil {
		return projectcatalog.Project{}, "", err
	}
	project, err := resolveProjectSelector(loaded.Catalog.Projects, selector)
	if err != nil {
		return projectcatalog.Project{}, "", err
	}
	discovered := map[string][]string{}
	if discover != nil {
		discovered, err = discover(ctx)
		if err != nil {
			return projectcatalog.Project{}, "", err
		}
	}
	paths := mergedLocalProjectPaths(project, discovered)
	switch len(paths) {
	case 0:
		return projectcatalog.Project{}, "", errors.New(project.Repository + " is not checked out locally on this machine")
	case 1:
		return project, paths[0], nil
	default:
		return projectcatalog.Project{}, "", errors.New(project.Repository + " has multiple local main checkouts; resolve this ambiguity first: " + strings.Join(paths, ", "))
	}
}
