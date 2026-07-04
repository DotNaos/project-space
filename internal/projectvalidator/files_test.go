package projectvalidator

import (
	"path/filepath"
	"testing"
)

func TestValidateTemplateFileTreatsGitHubActionsExpressionAsLiteralInSlotFile(t *testing.T) {
	templateRoot := t.TempDir()
	projectRoot := t.TempDir()
	mustWriteFile(t, filepath.Join(templateRoot, "workflow.yml.template"), "ref: ${{ github.ref }}\nbranch: {{ workflow.branch }}\n")
	mustWriteFile(t, filepath.Join(templateRoot, "slots.json"), `{"workflow.branch":"[a-z0-9/_-]+"}`)
	mustWriteFile(t, filepath.Join(projectRoot, "workflow.yml"), "ref: ${{ github.ref }}\nbranch: feature/demo\n")

	validation := validateTemplateFile(projectRoot, TemplateSpec{Root: templateRoot}, TemplateFileSpec{
		Path:         "workflow.yml",
		TemplatePath: "workflow.yml.template",
		SlotsPath:    "slots.json",
	}, TemplateValues{})

	if validation.Status != StatusOK {
		t.Fatalf("validation status = %s, code = %s, note = %s", validation.Status, validation.Code, validation.Note)
	}
}
