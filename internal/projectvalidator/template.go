package projectvalidator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func readTemplateLock(projectRoot string) (TemplateLock, error) {
	lockPath := filepath.Join(projectRoot, ".project", "template.lock.json")
	body, err := os.ReadFile(lockPath)
	if err != nil {
		return TemplateLock{}, fmt.Errorf("missing .project/template.lock.json in %s", projectRoot)
	}
	var lock TemplateLock
	if err := json.Unmarshal(body, &lock); err != nil {
		return TemplateLock{}, err
	}
	return lock, nil
}

func loadTemplate(projectRoot string, lock TemplateLock) (TemplateSpec, error) {
	templateRoot, err := resolveTemplateRoot(projectRoot, lock)
	if err != nil {
		return TemplateSpec{}, err
	}
	templatePath := filepath.Join(templateRoot, "template.yaml")
	body, err := os.ReadFile(templatePath)
	if err != nil {
		return TemplateSpec{}, fmt.Errorf("missing template.yaml in %s", templateRoot)
	}
	return parseTemplateYAML(templateRoot, string(body))
}

func readJSONFile[T any](filePath string) (T, error) {
	var value T
	body, err := os.ReadFile(filePath)
	if err != nil {
		return value, err
	}
	return value, json.Unmarshal(body, &value)
}

func resolveTemplateRoot(projectRoot string, lock TemplateLock) (string, error) {
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
			filepath.Join(".", "templates", "project-template"),
		}
		for _, candidate := range candidates {
			abs, _ := filepath.Abs(candidate)
			if _, err := os.Stat(filepath.Join(abs, "template.yaml")); err == nil {
				return abs, nil
			}
		}
	}
	return "", fmt.Errorf("cannot resolve template %q; add templatePath to the lock file", lock.Template)
}

func parseTemplateYAML(templateRoot string, body string) (TemplateSpec, error) {
	spec := TemplateSpec{Root: templateRoot, Files: map[string]TemplateFileSpec{}}
	currentFile := ""
	for _, rawLine := range strings.Split(body, "\n") {
		line := strings.TrimRight(rawLine, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || trimmed == "files:" {
			continue
		}
		if !strings.HasPrefix(line, " ") {
			key, value, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			value = strings.TrimSpace(value)
			switch key {
			case "name":
				spec.Name = value
			case "version":
				spec.Version = value
			case "structure":
				spec.StructurePath = value
			case "structureSlots":
				spec.StructureSlotsPath = value
			}
			currentFile = ""
			continue
		}
		if strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "    ") && strings.HasSuffix(trimmed, ":") {
			currentFile = strings.TrimSuffix(trimmed, ":")
			spec.Files[currentFile] = TemplateFileSpec{Path: currentFile}
			continue
		}
		if currentFile != "" && strings.HasPrefix(line, "    ") {
			key, value, ok := strings.Cut(trimmed, ":")
			if !ok {
				continue
			}
			fileSpec := spec.Files[currentFile]
			switch key {
			case "template":
				fileSpec.TemplatePath = strings.TrimSpace(value)
			case "slots":
				fileSpec.SlotsPath = strings.TrimSpace(value)
			}
			spec.Files[currentFile] = fileSpec
		}
	}
	if spec.Name == "" || spec.Version == "" || spec.StructurePath == "" || spec.StructureSlotsPath == "" {
		return TemplateSpec{}, fmt.Errorf("template.yaml is missing required fields")
	}
	return spec, nil
}
