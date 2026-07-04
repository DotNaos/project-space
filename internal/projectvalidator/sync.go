package projectvalidator

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/DotNaos/project-space/internal/placeholder"
	templatesnapshot "github.com/DotNaos/project-space/internal/snapshot"
)

type TemplateSyncOptions struct {
	TemplatePath string
	DryRun       bool
}

type TemplateSyncPlan struct {
	ProjectRoot  string
	SourceRoot   string
	SourceCommit string
	TargetRoot   string
	Checksum     string
	Files        []TemplateSyncFile
	WouldWrite   bool
}

type TemplateSyncFile struct {
	Action string
	Path   string
}

func SyncTemplate(projectRoot string, options TemplateSyncOptions) (string, string, error) {
	plan, err := PlanTemplateSync(projectRoot, options)
	if err != nil {
		return "", "", err
	}
	if options.DryRun {
		return plan.TargetRoot, plan.Checksum, nil
	}
	if err := os.RemoveAll(plan.TargetRoot); err != nil {
		return "", "", err
	}
	if err := copySnapshot(plan.SourceRoot, plan.TargetRoot); err != nil {
		return "", "", err
	}
	lock, err := readTemplateLock(plan.ProjectRoot)
	if err != nil {
		return "", "", err
	}
	if options.TemplatePath != "" {
		lock.TemplatePath = options.TemplatePath
	}
	if plan.SourceCommit != "" {
		lock.Commit = plan.SourceCommit
		lock.TemplatePath = ""
	}
	lock.Checksum = plan.Checksum
	lock.ChecksumVersion = templateChecksumVersion
	if _, err := writeTemplateLock(plan.ProjectRoot, lock); err != nil {
		return "", "", err
	}
	template, err := loadTemplateFromRoot(plan.TargetRoot)
	if err != nil {
		return "", "", err
	}
	if _, err := ensureTemplateValues(plan.ProjectRoot, template, lock.Modules); err != nil {
		return "", "", err
	}
	return plan.TargetRoot, plan.Checksum, nil
}

func PlanTemplateSync(projectRoot string, options TemplateSyncOptions) (TemplateSyncPlan, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return TemplateSyncPlan{}, err
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return TemplateSyncPlan{}, err
	}
	sourceLock := lock
	if options.TemplatePath != "" {
		sourceLock.TemplatePath = options.TemplatePath
	}
	source, err := resolveTemplateSource(root, sourceLock)
	if err != nil {
		return TemplateSyncPlan{}, err
	}
	targetRoot := filepath.Join(root, ".project", "template")
	checksum, err := checksumTemplateSourceSnapshot(source.Root)
	if err != nil {
		return TemplateSyncPlan{}, err
	}
	files, err := planTemplateSyncFiles(source.Root, targetRoot)
	if err != nil {
		return TemplateSyncPlan{}, err
	}
	return TemplateSyncPlan{
		ProjectRoot:  root,
		SourceRoot:   source.Root,
		SourceCommit: source.Commit,
		TargetRoot:   targetRoot,
		Checksum:     checksum,
		Files:        files,
		WouldWrite:   len(files) > 0 || lock.Checksum != checksum || options.TemplatePath != "" || source.Commit != "",
	}, nil
}

func resolveTemplateSourceRoot(projectRoot string, lock TemplateLock) (string, error) {
	source, err := resolveTemplateSource(projectRoot, lock)
	if err != nil {
		return "", err
	}
	return source.Root, nil
}

func resolveTemplateSource(projectRoot string, lock TemplateLock) (templatesnapshot.Source, error) {
	if lock.TemplatePath != "" {
		if filepath.IsAbs(lock.TemplatePath) {
			root, err := filepath.Abs(lock.TemplatePath)
			return templatesnapshot.Source{Root: root}, err
		}
		root, err := filepath.Abs(filepath.Join(projectRoot, ".project", lock.TemplatePath))
		return templatesnapshot.Source{Root: root}, err
	}
	if envTemplateRoot := os.Getenv("PROJECT_SPACE_TEMPLATE_ROOT"); envTemplateRoot != "" {
		root, err := filepath.Abs(envTemplateRoot)
		return templatesnapshot.Source{Root: root}, err
	}
	if lock.Template == "" {
		return templatesnapshot.Source{}, fmt.Errorf("cannot resolve template source; set template, templatePath, or PROJECT_SPACE_TEMPLATE_ROOT")
	}
	source, err := templatesnapshot.FetchTemplate(lock.Template, lock.Version, lock.Commit)
	if err != nil {
		return templatesnapshot.Source{}, fmt.Errorf("cannot resolve template source %q; set templatePath or PROJECT_SPACE_TEMPLATE_ROOT, or fetch from GitHub: %w", lock.Template, err)
	}
	return source, nil
}

func copySnapshot(source string, target string) error {
	paths, err := snapshotFiles(source)
	if err != nil {
		return err
	}
	selfValues, err := loadTemplateSelfValues(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return err
	}
	for _, relative := range paths {
		if err := copySnapshotFile(source, target, relative, selfValues); err != nil {
			return err
		}
	}
	return nil
}

func copySnapshotFile(sourceRoot string, targetRoot string, relative string, selfValues map[string]string) error {
	if len(selfValues) == 0 || strings.HasPrefix(relative, "template/") || strings.Contains(relative, ".template") {
		return copyFile(filepath.Join(sourceRoot, filepath.FromSlash(relative)), filepath.Join(targetRoot, filepath.FromSlash(relative)))
	}
	sourcePath := filepath.Join(sourceRoot, filepath.FromSlash(relative))
	body, err := os.ReadFile(sourcePath)
	if err != nil {
		return err
	}
	if bytes.Contains(body, []byte("{{")) {
		return writeFile(filepath.Join(targetRoot, filepath.FromSlash(relative)), body)
	}
	return writeFile(filepath.Join(targetRoot, filepath.FromSlash(relative)), placeholder.Unrender(body, selfValues))
}

func copyFile(source string, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	output, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer output.Close()
	_, err = io.Copy(output, input)
	return err
}

func writeFile(target string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, body, 0o644)
}

func planTemplateSyncFiles(sourceRoot string, targetRoot string) ([]TemplateSyncFile, error) {
	sourceFiles, err := collectTemplateSyncFiles(sourceRoot)
	if err != nil {
		return nil, err
	}
	targetFiles, err := collectAllTemplateSyncFiles(targetRoot)
	if err != nil {
		return nil, err
	}
	paths := map[string]bool{}
	for path := range sourceFiles {
		paths[path] = true
	}
	for path := range targetFiles {
		paths[path] = true
	}
	sortedPaths := make([]string, 0, len(paths))
	for path := range paths {
		sortedPaths = append(sortedPaths, path)
	}
	sort.Strings(sortedPaths)

	plan := []TemplateSyncFile{}
	for _, path := range sortedPaths {
		sourcePath, inSource := sourceFiles[path]
		targetPath, inTarget := targetFiles[path]
		switch {
		case inSource && !inTarget:
			plan = append(plan, TemplateSyncFile{Action: "ADD", Path: path})
		case !inSource && inTarget:
			plan = append(plan, TemplateSyncFile{Action: "DELETE", Path: path})
		default:
			equal, err := filesEqual(sourcePath, targetPath)
			if err != nil {
				return nil, err
			}
			if !equal {
				plan = append(plan, TemplateSyncFile{Action: "UPDATE", Path: path})
			}
		}
	}
	return plan, nil
}

func collectTemplateSyncFiles(root string) (map[string]string, error) {
	paths, err := snapshotFiles(root)
	if err != nil {
		return nil, err
	}
	files := map[string]string{}
	for _, relative := range paths {
		files[relative] = filepath.Join(root, filepath.FromSlash(relative))
	}
	return files, nil
}

func collectAllTemplateSyncFiles(root string) (map[string]string, error) {
	files := map[string]string{}
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return files, nil
	}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if shouldSkipTemplateWorkDir(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files[normalizePath(relative)] = path
		return nil
	})
	return files, err
}

func filesEqual(left string, right string) (bool, error) {
	leftBody, err := os.ReadFile(left)
	if err != nil {
		return false, err
	}
	rightBody, err := os.ReadFile(right)
	if err != nil {
		return false, err
	}
	return bytes.Equal(leftBody, rightBody), nil
}
