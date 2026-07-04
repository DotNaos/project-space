package projectvalidator

import (
	"os"
	"path/filepath"

	"github.com/DotNaos/project-space/internal/placeholder"
)

func validateTemplateFile(projectRoot string, template TemplateSpec, fileSpec TemplateFileSpec, values TemplateValues) FileValidation {
	projectFilePath := filepath.Join(projectRoot, fileSpec.Path)
	if _, err := os.Stat(projectFilePath); err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusMissing, Code: "missing", Note: "missing"}
	}
	templateBody, err := os.ReadFile(filepath.Join(template.Root, fileSpec.TemplatePath))
	if err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	rules, hasRules := fileRulesForPath(template, fileSpec.Path)
	if fileSpec.SlotsPath == "" {
		return validateRenderedTemplateFile(projectFilePath, fileSpec.Path, templateBody, values, rules, hasRules)
	}
	slotPatterns, err := readJSONFile[map[string]string](filepath.Join(template.Root, fileSpec.SlotsPath))
	if err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	actualBody, err := os.ReadFile(projectFilePath)
	if err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	parsedTemplate, err := placeholder.Parse(templateBody)
	if err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	compiled, _, err := parsedTemplate.ToRegex(slotPatterns)
	if err != nil {
		return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	diagnostics := []FileDiagnostic{}
	if hasRules {
		rendered, err := renderTemplateBody(templateBody, values)
		if err != nil {
			return FileValidation{Path: fileSpec.Path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
		}
		diagnostics = validateStructuredFile(projectFilePath, actualBody, rendered, rules)
	}
	if compiled.Match(actualBody) {
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

func validateRenderedTemplateFile(projectFilePath string, path string, templateBody []byte, values TemplateValues, rules TemplateFileRules, hasRules bool) FileValidation {
	actualBody, err := os.ReadFile(projectFilePath)
	if err != nil {
		return FileValidation{Path: path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	rendered, err := renderTemplateBody(templateBody, values)
	if err != nil {
		return FileValidation{Path: path, Status: StatusViolation, Code: "validator_error", Note: err.Error()}
	}
	diagnostics := []FileDiagnostic{}
	if hasRules {
		diagnostics = validateStructuredFile(projectFilePath, actualBody, rendered, rules)
	}
	if string(actualBody) == string(rendered) {
		return FileValidation{Path: path, Status: StatusOK, Code: "template", Note: "template", Diagnostics: diagnostics}
	}
	note := "template file changed"
	for _, diagnostic := range diagnostics {
		if diagnostic.Status == StatusViolation {
			note = diagnostic.Note
			break
		}
	}
	return FileValidation{Path: path, Status: StatusViolation, Code: "template_changed", Note: note, Diagnostics: diagnostics}
}
