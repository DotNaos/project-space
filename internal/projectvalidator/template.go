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
	body, err := os.ReadFile(yamlPath)
	if err != nil {
		return TemplateLock{}, fmt.Errorf("missing .project/template.lock.yaml in %s", projectRoot)
	}
	var lock TemplateLock
	if err := unmarshalYAML(body, &lock); err != nil {
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
	return "", fmt.Errorf("missing local template snapshot at %s; run project template sync to restore it", filepath.ToSlash(localSnapshot))
}

func findTemplateManifest(templateRoot string) (string, error) {
	manifest := filepath.Join(templateRoot, "template", "manifest.yaml")
	if _, err := os.Stat(manifest); err == nil {
		return manifest, nil
	}
	return "", fmt.Errorf("missing template manifest in %s; expected template/manifest.yaml", templateRoot)
}

func hasTemplateManifest(templateRoot string) bool {
	_, err := findTemplateManifest(templateRoot)
	return err == nil
}

func parseTemplateYAML(templateRoot string, manifestPath string, body []byte) (TemplateSpec, error) {
	var raw struct {
		Name    string                      `yaml:"name"`
		Version string                      `yaml:"version"`
		Files   map[string]TemplateFileSpec `yaml:"files"`
		Modules []yaml.Node                 `yaml:"modules"`
	}
	if err := unmarshalYAML(body, &raw); err != nil {
		return TemplateSpec{}, err
	}
	spec := TemplateSpec{
		Root:    templateRoot,
		Name:    raw.Name,
		Version: raw.Version,
		Files:   map[string]TemplateFileSpec{},
		Modules: map[string]TemplateModuleSpec{},
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
	if err := loadTemplateTree(&spec); err != nil {
		return TemplateSpec{}, err
	}
	if err := compileTemplateModuleOwnRules(&spec); err != nil {
		return TemplateSpec{}, err
	}
	if err := validateTemplateAppTargets(spec); err != nil {
		return TemplateSpec{}, err
	}
	selfValues, err := loadTemplateSelfValues(templateRoot)
	if err != nil {
		return TemplateSpec{}, err
	}
	spec.SelfValues = selfValues
	return spec, nil
}

func loadTemplateSelfValues(templateRoot string) (map[string]string, error) {
	valuesPath := filepath.Join(templateRoot, "template", "values.yaml")
	body, err := os.ReadFile(valuesPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var node yaml.Node
	if err := yaml.Unmarshal(body, &node); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.ToSlash(valuesPath), err)
	}
	values := map[string]string{}
	if err := flattenYAMLStringValues("", &node, values); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.ToSlash(valuesPath), err)
	}
	return values, nil
}

func flattenYAMLStringValues(prefix string, node *yaml.Node, values map[string]string) error {
	if node.Kind == yaml.DocumentNode && len(node.Content) == 1 {
		return flattenYAMLStringValues(prefix, node.Content[0], values)
	}
	switch node.Kind {
	case yaml.MappingNode:
		for index := 0; index < len(node.Content); index += 2 {
			key := node.Content[index].Value
			nextPrefix := key
			if prefix != "" {
				nextPrefix = prefix + "." + key
			}
			if err := flattenYAMLStringValues(nextPrefix, node.Content[index+1], values); err != nil {
				return err
			}
		}
	case yaml.ScalarNode:
		if prefix == "" {
			return fmt.Errorf("expected mapping")
		}
		values[prefix] = node.Value
	default:
		return fmt.Errorf("expected scalar or mapping at %s", prefix)
	}
	return nil
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
	default:
		return TemplateModuleSpec{}, fmt.Errorf("invalid module entry in %s; modules must reference files under template/modules", filepath.ToSlash(manifestPath))
	}
}

func loadTemplateTree(spec *TemplateSpec) error {
	ignore := readTemplateIgnore(spec.Root)
	slots, err := readSlotRules(spec.Root)
	if err != nil {
		return err
	}
	spec.TemplateFiles = map[string]bool{}
	spec.Slots = slots
	return filepath.WalkDir(spec.Root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if shouldSkipTemplateWorkDir(entry.Name()) {
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
