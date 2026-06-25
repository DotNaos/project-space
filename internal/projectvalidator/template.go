package projectvalidator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

func readTemplateLock(projectRoot string) (TemplateLock, error) {
	yamlPath := filepath.Join(projectRoot, ".project", "template.lock.yaml")
	if body, err := os.ReadFile(yamlPath); err == nil {
		var lock TemplateLock
		if err := unmarshalYAML(body, &lock); err != nil {
			return TemplateLock{}, err
		}
		return lock, nil
	}

	jsonPath := filepath.Join(projectRoot, ".project", "template.lock.json")
	body, err := os.ReadFile(jsonPath)
	if err != nil {
		return TemplateLock{}, fmt.Errorf("missing .project/template.lock.yaml in %s", projectRoot)
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
	if err := verifyTemplateChecksum(templateRoot, lock); err != nil {
		return TemplateSpec{}, err
	}
	templatePath := filepath.Join(templateRoot, "template.yaml")
	body, err := os.ReadFile(templatePath)
	if err != nil {
		return TemplateSpec{}, fmt.Errorf("missing template.yaml in %s", templateRoot)
	}
	return parseTemplateYAML(templateRoot, body)
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
	localSnapshot := filepath.Join(projectRoot, ".project", "template")
	if _, err := os.Stat(filepath.Join(localSnapshot, "template.yaml")); err == nil {
		return filepath.Abs(localSnapshot)
	}
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

func parseTemplateYAML(templateRoot string, body []byte) (TemplateSpec, error) {
	var raw struct {
		Name               string                      `yaml:"name"`
		Version            string                      `yaml:"version"`
		StructurePath      string                      `yaml:"structure"`
		StructureSlotsPath string                      `yaml:"structureSlots"`
		Files              map[string]TemplateFileSpec `yaml:"files"`
		Modules            []TemplateModuleSpec        `yaml:"modules"`
	}
	if err := unmarshalYAML(body, &raw); err != nil {
		return TemplateSpec{}, err
	}
	spec := TemplateSpec{
		Root:               templateRoot,
		Name:               raw.Name,
		Version:            raw.Version,
		StructurePath:      raw.StructurePath,
		StructureSlotsPath: raw.StructureSlotsPath,
		Files:              map[string]TemplateFileSpec{},
		Modules:            map[string]TemplateModuleSpec{},
	}
	for path, file := range raw.Files {
		file.Path = path
		spec.Files[path] = file
	}
	for _, module := range raw.Modules {
		if module.Name == "" {
			return TemplateSpec{}, fmt.Errorf("template.yaml contains a module without name")
		}
		spec.Modules[module.Name] = module
	}
	if spec.Name == "" || spec.Version == "" {
		return TemplateSpec{}, fmt.Errorf("template.yaml is missing required fields")
	}
	if spec.StructurePath != "" && spec.StructureSlotsPath != "" {
		return spec, nil
	}
	if err := loadTemplateTree(&spec); err != nil {
		return TemplateSpec{}, err
	}
	return spec, nil
}

func loadTemplateTree(spec *TemplateSpec) error {
	ignore := readTemplateIgnore(spec.Root)
	slots, err := readSlotRules(spec.Root)
	if err != nil {
		return err
	}
	spec.TreeMode = true
	spec.TemplateFiles = map[string]bool{}
	spec.Slots = slots
	return filepath.WalkDir(spec.Root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := filepath.Rel(spec.Root, path)
		if err != nil {
			return err
		}
		normalized := normalizePath(relative)
		if ignore.Match(normalized) {
			return nil
		}
		spec.TemplateFiles[normalized] = true
		spec.Files[normalized] = TemplateFileSpec{Path: normalized, TemplatePath: normalized}
		return nil
	})
}
