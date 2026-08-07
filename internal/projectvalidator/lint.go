package projectvalidator

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/DotNaos/project-space/internal/placeholder"
	yaml "gopkg.in/yaml.v3"
)

type TemplateLintReport struct {
	TemplateRoot string                `json:"templateRoot"`
	Template     string                `json:"template"`
	Version      string                `json:"version"`
	OK           bool                  `json:"ok"`
	Findings     []TemplateLintFinding `json:"findings"`
}

type TemplateLintFinding struct {
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Path     string `json:"path,omitempty"`
	Message  string `json:"message"`
}

func LintTemplate(templateRoot string) (TemplateLintReport, error) {
	root, err := filepath.Abs(templateRoot)
	if err != nil {
		return TemplateLintReport{}, err
	}
	report := TemplateLintReport{TemplateRoot: root, OK: true}
	findings := []TemplateLintFinding{}
	addFinding := func(severity string, code string, path string, message string) {
		findings = append(findings, TemplateLintFinding{Severity: severity, Code: code, Path: normalizePath(path), Message: message})
	}

	addSchemaParseFindings(root, addFinding)
	addTemplateIgnoreFindings(root, addFinding)
	addSlotFindings(root, addFinding)

	template, err := loadTemplateFromRoot(root)
	if err != nil {
		addFinding("error", "template_parse", "template/manifest.yaml", err.Error())
		report.Findings = sortedLintFindings(findings)
		report.OK = false
		return report, nil
	}
	report.Template = template.Name
	report.Version = template.Version

	addStrictYAMLFindings(root, addFinding)
	addOwnershipFindings(template, addFinding)
	addPlaceholderFindings(template, addFinding)
	addDefaultResolutionFindings(root, template, addFinding)
	addTemplateSelfValueFindings(template, addFinding)

	report.Findings = sortedLintFindings(findings)
	report.OK = true
	for _, finding := range report.Findings {
		if finding.Severity == "error" {
			report.OK = false
			break
		}
	}
	return report, nil
}

func addSchemaParseFindings(templateRoot string, addFinding func(string, string, string, string)) {
	for _, path := range []string{"schema/template-manifest.schema.json", "schema/template-module.schema.json"} {
		body, err := os.ReadFile(filepath.Join(templateRoot, filepath.FromSlash(path)))
		if err != nil {
			addFinding("error", "schema_missing", path, err.Error())
			continue
		}
		var raw any
		if err := json.Unmarshal(body, &raw); err != nil {
			addFinding("error", "schema_invalid", path, err.Error())
		}
	}
	valuesSchemaPath := "schema/template-values.schema.json"
	if _, err := os.Stat(filepath.Join(templateRoot, filepath.FromSlash(valuesSchemaPath))); err == nil {
		body, err := os.ReadFile(filepath.Join(templateRoot, filepath.FromSlash(valuesSchemaPath)))
		if err != nil {
			addFinding("error", "schema_missing", valuesSchemaPath, err.Error())
			return
		}
		var raw any
		if err := json.Unmarshal(body, &raw); err != nil {
			addFinding("error", "schema_invalid", valuesSchemaPath, err.Error())
		}
	}
}

func addStrictYAMLFindings(templateRoot string, addFinding func(string, string, string, string)) {
	manifestPath := filepath.Join(templateRoot, "template", "manifest.yaml")
	manifestBody, err := os.ReadFile(manifestPath)
	if err != nil {
		addFinding("error", "manifest_missing", "template/manifest.yaml", err.Error())
		return
	}
	var raw struct {
		Name    string                      `yaml:"name"`
		Version string                      `yaml:"version"`
		Files   map[string]TemplateFileSpec `yaml:"files"`
		Modules []string                    `yaml:"modules"`
	}
	if err := decodeStrictYAML(manifestBody, &raw); err != nil {
		addFinding("error", "manifest_schema", "template/manifest.yaml", err.Error())
		return
	}
	if raw.Name == "" {
		addFinding("error", "manifest_schema", "template/manifest.yaml", "missing name")
	}
	if raw.Version == "" {
		addFinding("error", "manifest_schema", "template/manifest.yaml", "missing version")
	}
	for _, modulePath := range raw.Modules {
		normalized := normalizePath(filepath.Join("template", filepath.FromSlash(modulePath)))
		body, err := os.ReadFile(filepath.Join(templateRoot, filepath.FromSlash(normalized)))
		if err != nil {
			addFinding("error", "module_missing", normalized, err.Error())
			continue
		}
		var module TemplateModuleSpec
		if err := decodeStrictYAML(body, &module); err != nil {
			addFinding("error", "module_schema", normalized, err.Error())
			continue
		}
		if module.Name == "" {
			addFinding("error", "module_schema", normalized, "missing name")
		}
		if module.Description == "" {
			addFinding("error", "module_schema", normalized, "missing description")
		}
		if len(module.Owns) == 0 {
			addFinding("error", "module_schema", normalized, "missing owns")
		}
	}
}

func decodeStrictYAML(body []byte, value any) error {
	decoder := yaml.NewDecoder(bytes.NewReader(body))
	decoder.KnownFields(true)
	return decoder.Decode(value)
}

func addTemplateIgnoreFindings(templateRoot string, addFinding func(string, string, string, string)) {
	body, err := os.ReadFile(filepath.Join(templateRoot, ".templateignore"))
	if err != nil {
		return
	}
	for index, rawLine := range strings.Split(string(body), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasSuffix(line, "/") {
			line += "**"
		}
		if _, err := compilePathPattern(line, nil); err != nil {
			addFinding("error", "templateignore_invalid", ".templateignore", fmt.Sprintf("line %d: %v", index+1, err))
		}
	}
}

func addOwnershipFindings(template TemplateSpec, addFinding func(string, string, string, string)) {
	owners := moduleOwnershipMatchers(template, addFinding)
	for path := range template.TemplateFiles {
		matches := []string{}
		for _, owner := range owners {
			if owner.match(path) {
				matches = append(matches, owner.module)
			}
		}
		switch len(matches) {
		case 0:
			addFinding("error", "ownership_missing", path, "no module owns this template output")
		case 1:
		default:
			addFinding("warning", "ownership_overlap", path, "owned by multiple modules: "+strings.Join(matches, ", "))
		}
	}
}

type lintOwner struct {
	module string
	match  func(string) bool
}

func moduleOwnershipMatchers(template TemplateSpec, addFinding func(string, string, string, string)) []lintOwner {
	moduleNames := make([]string, 0, len(template.Modules))
	for name := range template.Modules {
		moduleNames = append(moduleNames, name)
	}
	sort.Strings(moduleNames)
	owners := []lintOwner{}
	for _, moduleName := range moduleNames {
		for _, pattern := range template.Modules[moduleName].Owns {
			regex, err := compilePathPattern(pattern, nil)
			if err != nil {
				addFinding("error", "ownership_pattern", moduleName, fmt.Sprintf("owns pattern %q: %v", pattern, err))
				continue
			}
			owners = append(owners, lintOwner{module: moduleName, match: regex.MatchString})
		}
	}
	return owners
}

func addPlaceholderFindings(template TemplateSpec, addFinding func(string, string, string, string)) {
	declared := declaredTemplateValues(template)
	used := map[string]bool{}
	for _, fileSpec := range sortedTemplateFileSpecs(template.Files) {
		body, err := os.ReadFile(filepath.Join(template.Root, filepath.FromSlash(fileSpec.TemplatePath)))
		if err != nil {
			addFinding("error", "template_file_read", fileSpec.TemplatePath, err.Error())
			continue
		}
		if len(template.SelfValues) > 0 && !strings.Contains(fileSpec.TemplatePath, ".template") && !bytes.Contains(body, []byte("{{")) {
			body = placeholder.Unrender(body, template.SelfValues)
		}
		parsed, err := placeholder.Parse(body)
		if err != nil {
			addFinding("error", "placeholder_invalid", fileSpec.TemplatePath, err.Error())
			continue
		}
		conditionPaths, err := conditionalTemplatePaths(body)
		if err != nil {
			addFinding("error", "conditional_invalid", fileSpec.TemplatePath, err.Error())
			continue
		}
		for _, name := range conditionPaths {
			used[name] = true
			spec, ok := allTemplateValueSpecs(template)[name]
			if !ok {
				addFinding("error", "conditional_undeclared", fileSpec.TemplatePath, fmt.Sprintf("condition %s is not declared by any module", name))
				continue
			}
			if spec.Type != "boolean" {
				addFinding("error", "conditional_type", fileSpec.TemplatePath, fmt.Sprintf("condition %s must declare type boolean", name))
			}
		}
		for _, name := range parsed.Placeholders() {
			used[name] = true
			if !declared[name] {
				addFinding("error", "placeholder_undeclared", fileSpec.TemplatePath, fmt.Sprintf("placeholder %s is not declared by any module", name))
			}
		}
	}
	for name, spec := range allTemplateValueSpecs(template) {
		for _, source := range []string{spec.Default, spec.DefaultFrom} {
			if source == "" {
				continue
			}
			if spec.DefaultFrom != "" && source == spec.DefaultFrom {
				used[source] = true
				if !declared[source] {
					addFinding("error", "placeholder_undeclared", name, fmt.Sprintf("defaultFrom references undeclared value %s", source))
				}
				continue
			}
			parsed, err := placeholder.Parse([]byte(source))
			if err != nil {
				addFinding("error", "placeholder_invalid", name, err.Error())
				continue
			}
			for _, placeholderName := range parsed.Placeholders() {
				used[placeholderName] = true
				if !declared[placeholderName] {
					addFinding("error", "placeholder_undeclared", name, fmt.Sprintf("default references undeclared value %s", placeholderName))
				}
			}
		}
	}
	for name := range declared {
		if !used[name] {
			addFinding("warning", "value_unused", name, "declared value is not used by template files or defaults")
		}
	}
}

func declaredTemplateValues(template TemplateSpec) map[string]bool {
	values := map[string]bool{}
	for name := range allTemplateValueSpecs(template) {
		values[name] = true
	}
	return values
}

func allTemplateValueSpecs(template TemplateSpec) map[string]TemplateValueSpec {
	values := map[string]TemplateValueSpec{}
	for _, module := range template.Modules {
		for name, spec := range module.Values {
			values[name] = spec
		}
	}
	return values
}

func sortedTemplateFileSpecs(files map[string]TemplateFileSpec) []TemplateFileSpec {
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	result := make([]TemplateFileSpec, 0, len(paths))
	for _, path := range paths {
		result = append(result, files[path])
	}
	return result
}

func addDefaultResolutionFindings(templateRoot string, template TemplateSpec, addFinding func(string, string, string, string)) {
	modules, err := defaultModuleClosure(template.Modules)
	if err != nil {
		addFinding("error", "default_modules", "template/manifest.yaml", err.Error())
		return
	}
	if _, err := defaultTemplateValuesForProject(filepath.Join(templateRoot, "example-project"), template, modules); err != nil {
		addFinding("error", "default_values", "template/modules", err.Error())
	}
}

func addSlotFindings(templateRoot string, addFinding func(string, string, string, string)) {
	if _, err := readSlotRules(templateRoot); err != nil {
		addFinding("error", "slot_invalid", "", err.Error())
	}
}

func addTemplateSelfValueFindings(template TemplateSpec, addFinding func(string, string, string, string)) {
	if len(template.SelfValues) == 0 {
		return
	}
	names := make([]string, 0, len(template.SelfValues))
	for name := range template.SelfValues {
		names = append(names, name)
		if _, err := placeholder.Parse([]byte("{{ " + name + " }}")); err != nil {
			addFinding("error", "self_value_invalid", "template/values.yaml", err.Error())
		}
		if len(template.SelfValues[name]) < 3 {
			addFinding("error", "self_value_short", "template/values.yaml", fmt.Sprintf("%s is shorter than 3 characters", name))
		}
	}
	sort.Strings(names)
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			left := template.SelfValues[names[i]]
			right := template.SelfValues[names[j]]
			if left != "" && left == right {
				addFinding("error", "self_value_ambiguous", "template/values.yaml", fmt.Sprintf("%s and %s have the same value", names[i], names[j]))
			}
		}
	}
	values := TemplateValues{}
	for _, name := range names {
		setTemplateValue(values, name, template.SelfValues[name])
	}
	paths, err := snapshotFiles(template.Root)
	if err != nil {
		addFinding("error", "self_value_roundtrip", "template/values.yaml", err.Error())
		return
	}
	for _, relative := range paths {
		if strings.HasPrefix(relative, "template/") || strings.Contains(relative, ".template") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(template.Root, filepath.FromSlash(relative)))
		if err != nil {
			addFinding("error", "self_value_roundtrip", relative, err.Error())
			continue
		}
		if bytes.Contains(body, []byte("{{")) {
			continue
		}
		unrendered := placeholder.Unrender(body, template.SelfValues)
		parsed, err := placeholder.Parse(unrendered)
		if err != nil {
			addFinding("error", "self_value_roundtrip", relative, err.Error())
			continue
		}
		rendered, err := parsed.Render(placeholderValues(values))
		if err != nil {
			addFinding("error", "self_value_roundtrip", relative, err.Error())
			continue
		}
		if !bytes.Equal(rendered, body) {
			addFinding("error", "self_value_roundtrip", relative, "render(unrender(file), template values) did not reproduce the source")
		}
	}
}

func sortedLintFindings(findings []TemplateLintFinding) []TemplateLintFinding {
	sort.SliceStable(findings, func(i, j int) bool {
		if findings[i].Severity != findings[j].Severity {
			return findings[i].Severity < findings[j].Severity
		}
		if findings[i].Path != findings[j].Path {
			return findings[i].Path < findings[j].Path
		}
		if findings[i].Code != findings[j].Code {
			return findings[i].Code < findings[j].Code
		}
		return findings[i].Message < findings[j].Message
	})
	return findings
}
