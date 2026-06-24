package projectvalidator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

func validateTemplateFile(projectRoot string, templateRoot string, fileSpec TemplateFileSpec, values TemplateValues) FileValidation {
	projectFilePath := filepath.Join(projectRoot, fileSpec.Path)
	if _, err := os.Stat(projectFilePath); err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusMissing, Code: "missing", Note: "missing"}
	}
	templateBody, err := os.ReadFile(filepath.Join(templateRoot, fileSpec.TemplatePath))
	if err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	if fileSpec.SlotsPath == "" {
		return validateRenderedTemplateFile(projectFilePath, fileSpec.Path, templateBody, values)
	}
	slotPatterns, err := readJSONFile[map[string]string](filepath.Join(templateRoot, fileSpec.SlotsPath))
	if err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	actualBody, err := os.ReadFile(projectFilePath)
	if err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	compiled, err := compileTemplateRegex(string(templateBody), slotPatterns)
	if err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	diagnostics := []FileDiagnostic{}
	if fileSpec.Path == "package.json" {
		diagnostics = diagnosePackageJSON(projectFilePath)
	}
	if compiled.regex.Match(actualBody) {
		return FileValidation{Path: fileSpec.Path, Status: StatusOK, Code: "template", Note: "template", Diagnostics: diagnostics}
	}
	note := "frozen region changed"
	for _, diagnostic := range diagnostics {
		if diagnostic.Status == StatusViolation {
			note = diagnostic.Note
			break
		}
	}
	return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "frozen_changed", Note: note, Diagnostics: diagnostics}
}

func validateRenderedTemplateFile(projectFilePath string, path string, templateBody []byte, values TemplateValues) FileValidation {
	actualBody, err := os.ReadFile(projectFilePath)
	if err != nil {
		return FileValidation{Path: path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	rendered, err := renderTemplateValues(templateBody, values)
	if err != nil {
		return FileValidation{Path: path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	if string(actualBody) == string(rendered) {
		return FileValidation{Path: path, Status: StatusOK, Code: "template", Note: "template"}
	}
	return FileValidation{Path: path, Status: StatusViolation, Code: "template_changed", Note: "template file changed"}
}

func diagnosePackageJSON(packageJSONPath string) []FileDiagnostic {
	body, err := os.ReadFile(packageJSONPath)
	if err != nil {
		return []FileDiagnostic{{Path: "package.json", Status: StatusViolation, Note: err.Error()}}
	}
	var pkg map[string]any
	if err := json.Unmarshal(body, &pkg); err != nil {
		return []FileDiagnostic{{Path: "package.json", Status: StatusViolation, Note: err.Error()}}
	}

	diagnostics := []FileDiagnostic{}
	checkSlotString(&diagnostics, "/name", pkg["name"], regexp.MustCompile(`^[a-z0-9-]+$`), "slot: project.name")
	checkFrozen(&diagnostics, "/version", pkg["version"], "0.1.0")
	checkFrozen(&diagnostics, "/type", pkg["type"], "module")
	checkFrozen(&diagnostics, "/packageManager", pkg["packageManager"], "bun@1.2.0")

	scripts := objectValue(pkg["scripts"])
	checkFrozen(&diagnostics, "/scripts/dev", scripts["dev"], "vite dev")
	checkFrozen(&diagnostics, "/scripts/build", scripts["build"], "vite build")
	checkFrozen(&diagnostics, "/scripts/test", scripts["test"], "vitest")
	for key, value := range scripts {
		if key == "dev" || key == "build" || key == "test" {
			continue
		}
		if regexp.MustCompile(`^custom:[a-z0-9:-]+$`).MatchString(key) {
			if _, ok := value.(string); ok {
				diagnostics = append(diagnostics, FileDiagnostic{Path: "/scripts/" + key, Status: StatusOK, Note: "slot: package.extra_scripts"})
				continue
			}
		}
		diagnostics = append(diagnostics, FileDiagnostic{Path: "/scripts/" + key, Status: StatusViolation, Note: "not allowed by template"})
	}

	dependencies := objectValue(pkg["dependencies"])
	frozenDependencies := map[string]string{
		"@heroui/react": "2.7.8",
		"react":         "19.0.0",
		"react-dom":     "19.0.0",
	}
	for key, expected := range frozenDependencies {
		checkFrozen(&diagnostics, "/dependencies/"+key, dependencies[key], expected)
	}
	for key := range dependencies {
		if _, ok := frozenDependencies[key]; !ok {
			diagnostics = append(diagnostics, FileDiagnostic{Path: "/dependencies/" + key, Status: StatusViolation, Note: "not allowed by template"})
		}
	}
	return diagnostics
}

func checkFrozen(diagnostics *[]FileDiagnostic, key string, actual any, expected string) {
	if actual == expected {
		*diagnostics = append(*diagnostics, FileDiagnostic{Path: key, Status: StatusOK, Note: "frozen"})
		return
	}
	*diagnostics = append(*diagnostics, FileDiagnostic{Path: key, Status: StatusViolation, Note: fmt.Sprintf("expected frozen value: %q", expected)})
}

func checkSlotString(diagnostics *[]FileDiagnostic, key string, actual any, pattern *regexp.Regexp, note string) {
	value, ok := actual.(string)
	if ok && pattern.MatchString(value) {
		*diagnostics = append(*diagnostics, FileDiagnostic{Path: key, Status: StatusOK, Note: note})
		return
	}
	*diagnostics = append(*diagnostics, FileDiagnostic{Path: key, Status: StatusViolation, Note: "invalid " + note})
}

func objectValue(value any) map[string]any {
	if object, ok := value.(map[string]any); ok {
		return object
	}
	return map[string]any{}
}
