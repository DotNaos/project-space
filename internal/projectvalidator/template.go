package projectvalidator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	yaml "gopkg.in/yaml.v3"
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
	templatePath, err := findTemplateManifest(templateRoot)
	if err != nil {
		return TemplateSpec{}, err
	}
	body, err := os.ReadFile(templatePath)
	if err != nil {
		return TemplateSpec{}, err
	}
	return parseTemplateYAML(templateRoot, templatePath, body)
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
	if hasTemplateManifest(localSnapshot) {
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
			if hasTemplateManifest(abs) {
				return abs, nil
			}
		}
	}
	return "", fmt.Errorf("cannot resolve template %q; add templatePath to the lock file", lock.Template)
}

func findTemplateManifest(templateRoot string) (string, error) {
	preferred := filepath.Join(templateRoot, "template", "manifest.yaml")
	if _, err := os.Stat(preferred); err == nil {
		return preferred, nil
	}
	legacy := filepath.Join(templateRoot, "template.yaml")
	if _, err := os.Stat(legacy); err == nil {
		return legacy, nil
	}
	return "", fmt.Errorf("missing template manifest in %s; expected template/manifest.yaml or template.yaml", templateRoot)
}

func hasTemplateManifest(templateRoot string) bool {
	_, err := findTemplateManifest(templateRoot)
	return err == nil
}

func parseTemplateYAML(templateRoot string, manifestPath string, body []byte) (TemplateSpec, error) {
	var raw struct {
		Name               string                      `yaml:"name"`
		Version            string                      `yaml:"version"`
		StructurePath      string                      `yaml:"structure"`
		StructureSlotsPath string                      `yaml:"structureSlots"`
		Files              map[string]TemplateFileSpec `yaml:"files"`
		Modules            []yaml.Node                 `yaml:"modules"`
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
	for _, moduleNode := range raw.Modules {
		module, err := decodeTemplateModule(manifestPath, moduleNode)
		if err != nil {
			return TemplateSpec{}, err
		}
		if module.Name == "" {
			return TemplateSpec{}, fmt.Errorf("%s contains a module without name", filepath.ToSlash(manifestPath))
		}
		spec.Modules[module.Name] = module
	}
	if spec.Name == "" || spec.Version == "" {
		return TemplateSpec{}, fmt.Errorf("%s is missing required fields", filepath.ToSlash(manifestPath))
	}
	if spec.StructurePath != "" && spec.StructureSlotsPath != "" {
		return spec, nil
	}
	if err := loadTemplateTree(&spec); err != nil {
		return TemplateSpec{}, err
	}
	return spec, nil
}

func decodeTemplateModule(manifestPath string, moduleNode yaml.Node) (TemplateModuleSpec, error) {
	switch moduleNode.Kind {
	case yaml.ScalarNode:
		modulePath := filepath.Join(filepath.Dir(manifestPath), filepath.FromSlash(moduleNode.Value))
		body, err := os.ReadFile(modulePath)
		if err != nil {
			return TemplateModuleSpec{}, err
		}
		var module TemplateModuleSpec
		if err := unmarshalYAML(body, &module); err != nil {
			return TemplateModuleSpec{}, fmt.Errorf("%s: %w", filepath.ToSlash(modulePath), err)
		}
		return module, nil
	case yaml.MappingNode:
		var module TemplateModuleSpec
		if err := moduleNode.Decode(&module); err != nil {
			return TemplateModuleSpec{}, err
		}
		return module, nil
	default:
		return TemplateModuleSpec{}, fmt.Errorf("invalid module entry in %s", filepath.ToSlash(manifestPath))
	}
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
		outputPath := templateOutputPath(normalized)
		if existing, ok := spec.Files[outputPath]; ok {
			return fmt.Errorf("template files %s and %s both render to %s", existing.TemplatePath, normalized, outputPath)
		}
		spec.TemplateFiles[outputPath] = true
		spec.Files[outputPath] = TemplateFileSpec{Path: outputPath, TemplatePath: normalized}
		return nil
	})
}

func templateOutputPath(templatePath string) string {
	segments := strings.Split(normalizePath(templatePath), "/")
	for index, segment := range segments {
		segments[index] = strings.ReplaceAll(segment, ".template", "")
	}
	return strings.Join(segments, "/")
}
