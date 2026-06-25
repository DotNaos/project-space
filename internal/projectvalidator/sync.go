package projectvalidator

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type TemplateSyncOptions struct {
	TemplatePath string
}

func SyncTemplate(projectRoot string, options TemplateSyncOptions) (string, string, error) {
	root, err := filepath.Abs(projectRoot)
	if err != nil {
		return "", "", err
	}
	lock, err := readTemplateLock(root)
	if err != nil {
		return "", "", err
	}
	sourceLock := lock
	if options.TemplatePath != "" {
		sourceLock.TemplatePath = options.TemplatePath
	}
	sourceRoot, err := resolveTemplateSourceRoot(root, sourceLock)
	if err != nil {
		return "", "", err
	}
	targetRoot := filepath.Join(root, ".project", "template")
	if err := os.RemoveAll(targetRoot); err != nil {
		return "", "", err
	}
	if err := copyDirectory(sourceRoot, targetRoot); err != nil {
		return "", "", err
	}
	checksum, err := checksumTemplateRoot(targetRoot)
	if err != nil {
		return "", "", err
	}
	lock.Checksum = checksum
	if options.TemplatePath != "" {
		lock.TemplatePath = options.TemplatePath
	}
	if _, err := writeTemplateLock(root, lock); err != nil {
		return "", "", err
	}
	return targetRoot, checksum, nil
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
			if entry.Name() == ".git" {
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
