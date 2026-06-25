package projectvalidator

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type InitOptions struct {
	Template     string
	TemplatePath string
	Version      string
	Commit       string
	Force        bool
}

func CreateProject(projectRoot string, options InitOptions) (string, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return "", err
	}
	if stat, err := os.Stat(root); err == nil {
		if !stat.IsDir() {
			return "", fmt.Errorf("%s already exists and is not a directory", root)
		}
		empty, err := isEmptyDirectory(root)
		if err != nil {
			return "", err
		}
		if !empty {
			return "", fmt.Errorf("%s already exists and is not empty; use init for existing projects", root)
		}
	} else if os.IsNotExist(err) {
		if err := os.MkdirAll(root, 0o755); err != nil {
			return "", err
		}
	} else {
		return "", err
	}
	return InitProject(root, options)
}

func InitProject(projectRoot string, options InitOptions) (string, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return "", err
	}
	template := options.Template
	if template == "" {
		template = "DotNaos/project-template"
	}
	version := options.Version
	if version == "" {
		version = "0.1.0"
	}
	commit := options.Commit
	if commit == "" {
		commit = "local"
	}
	templatePath, err := resolveInitTemplatePath(root, options.TemplatePath)
	if err != nil {
		return "", err
	}
	lockPath := filepath.Join(root, ".project", "template.lock.yaml")
	if _, err := os.Stat(lockPath); err == nil && !options.Force {
		return "", fmt.Errorf("%s already exists; use --force to replace it", lockPath)
	}
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return "", err
	}
	lock := TemplateLock{
		Template:     template,
		Version:      version,
		Commit:       commit,
		TemplatePath: templatePath,
	}
	body, err := marshalYAML(lock)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(lockPath, body, 0o644); err != nil {
		return "", err
	}
	return lockPath, nil
}

func isEmptyDirectory(path string) (bool, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}

func writeTemplateLock(projectRoot string, lock TemplateLock) (string, error) {
	lockPath := filepath.Join(projectRoot, ".project", "template.lock.yaml")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return "", err
	}
	body, err := marshalYAML(lock)
	if err != nil {
		return "", err
	}
	return lockPath, os.WriteFile(lockPath, body, 0o644)
}

func resolveInitTemplatePath(projectRoot string, requestedPath string) (string, error) {
	templateRoot := requestedPath
	if templateRoot == "" {
		templateRoot = os.Getenv("PROJECT_SPACE_TEMPLATE_ROOT")
	}
	if templateRoot == "" {
		templateRoot = filepath.Join(mustWorkingDirectory(), "templates", "project-template")
	}
	absTemplateRoot, err := filepath.Abs(templateRoot)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(absTemplateRoot, "template.yaml")); err != nil {
		return "", fmt.Errorf("template path %s does not contain template.yaml", absTemplateRoot)
	}
	projectRelativeTemplatePath, err := filepath.Rel(projectRoot, absTemplateRoot)
	if err == nil && !isParentRelative(projectRelativeTemplatePath) {
		lockDir := filepath.Join(projectRoot, ".project")
		relativeTemplatePath, err := filepath.Rel(lockDir, absTemplateRoot)
		if err == nil {
			return filepath.ToSlash(relativeTemplatePath), nil
		}
	}
	return absTemplateRoot, nil
}

func isParentRelative(pathValue string) bool {
	return pathValue == ".." || strings.HasPrefix(pathValue, ".."+string(filepath.Separator)) || strings.HasPrefix(filepath.ToSlash(pathValue), "../")
}

func mustWorkingDirectory() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}
