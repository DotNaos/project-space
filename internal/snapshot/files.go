package snapshot

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func Files(templateRoot string) ([]string, error) {
	if _, err := os.Stat(templateRoot); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	ignore := ReadTemplateIgnore(templateRoot)
	paths := []string{}
	if err := filepath.WalkDir(templateRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if shouldSkipTemplateWorkDir(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := filepath.Rel(templateRoot, path)
		if err != nil {
			return err
		}
		normalized := normalizePath(relative)
		if IncludeInSnapshot(normalized, ignore) {
			paths = append(paths, normalized)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	sort.Strings(paths)
	return paths, nil
}

func IncludeInSnapshot(path string, ignore Ignore) bool {
	if path == ".templateignore" {
		return true
	}
	if strings.HasPrefix(path, "template/") {
		return true
	}
	if path == ".slot.yaml" || strings.HasSuffix(path, "/.slot.yaml") {
		return true
	}
	return !ignore.Match(path)
}
