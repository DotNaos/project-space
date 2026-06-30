package projectvalidator

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

type TemplateSyncOptions struct {
	TemplatePath string
	DryRun       bool
}

type TemplateSyncPlan struct {
	ProjectRoot string
	SourceRoot  string
	TargetRoot  string
	Checksum    string
	Files       []TemplateSyncFile
	WouldWrite  bool
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
	if err := copyDirectory(plan.SourceRoot, plan.TargetRoot); err != nil {
		return "", "", err
	}
	lock, err := readTemplateLock(plan.ProjectRoot)
	if err != nil {
		return "", "", err
	}
	if options.TemplatePath != "" {
		lock.TemplatePath = options.TemplatePath
	}
	lock.Checksum = plan.Checksum
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
	sourceRoot, err := resolveTemplateSourceRoot(root, sourceLock)
	if err != nil {
		return TemplateSyncPlan{}, err
	}
	targetRoot := filepath.Join(root, ".project", "template")
	checksum, err := checksumTemplateRoot(sourceRoot)
	if err != nil {
		return TemplateSyncPlan{}, err
	}
	files, err := planTemplateSyncFiles(sourceRoot, targetRoot)
	if err != nil {
		return TemplateSyncPlan{}, err
	}
	return TemplateSyncPlan{
		ProjectRoot: root,
		SourceRoot:  sourceRoot,
		TargetRoot:  targetRoot,
		Checksum:    checksum,
		Files:       files,
		WouldWrite:  len(files) > 0 || lock.Checksum != checksum || options.TemplatePath != "",
	}, nil
}

func resolveTemplateSourceRoot(projectRoot string, lock TemplateLock) (string, error) {
	if lock.TemplatePath != "" {
		if filepath.IsAbs(lock.TemplatePath) {
			return filepath.Abs(lock.TemplatePath)
		}
		return filepath.Abs(filepath.Join(projectRoot, ".project", lock.TemplatePath))
	}
	if envTemplateRoot := os.Getenv("PROJECT_SPACE_TEMPLATE_ROOT"); envTemplateRoot != "" {
		return filepath.Abs(envTemplateRoot)
	}
	if lock.Template == "DotNaos/project-template" {
		candidates := []string{
			filepath.Join(projectRoot, "..", "project-template"),
			"/Users/oli/projects/project-template",
			filepath.Join(projectRoot, "templates", "project-template"),
		}
		for _, candidate := range candidates {
			abs, _ := filepath.Abs(candidate)
			if hasTemplateManifest(abs) {
				return abs, nil
			}
		}
	}
	return "", fmt.Errorf("cannot resolve template source %q; set templatePath or PROJECT_SPACE_TEMPLATE_ROOT", lock.Template)
}

func copyDirectory(source string, target string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return os.MkdirAll(target, 0o755)
		}
		if entry.IsDir() {
			if shouldSkipTemplateWorkDir(entry.Name()) {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(target, relative), 0o755)
		}
		return copyFile(path, filepath.Join(target, relative))
	})
}

func copyFile(source string, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer output.Close()
	_, err = io.Copy(output, input)
	return err
}

func planTemplateSyncFiles(sourceRoot string, targetRoot string) ([]TemplateSyncFile, error) {
	sourceFiles, err := collectTemplateSyncFiles(sourceRoot)
	if err != nil {
		return nil, err
	}
	targetFiles, err := collectTemplateSyncFiles(targetRoot)
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
