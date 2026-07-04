package projectvalidator

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestLintTemplatePassesValidTemplate(t *testing.T) {
	templateRoot := writeLintTemplate(t, lintTemplateOptions{})

	report, err := LintTemplate(templateRoot)
	if err != nil {
		t.Fatalf("LintTemplate returned error: %v", err)
	}
	if !report.OK {
		t.Fatalf("lint failed: %+v", report.Findings)
	}
	if len(report.Findings) != 0 {
		t.Fatalf("expected no findings, got %+v", report.Findings)
	}
}

func TestLintTemplateReportsViolationClasses(t *testing.T) {
	tests := []struct {
		name       string
		options    lintTemplateOptions
		wantCode   string
		wantText   string
		wantFailed bool
	}{
		{
			name:       "missing ownership",
			options:    lintTemplateOptions{ExtraTemplateFile: true},
			wantCode:   "ownership_missing",
			wantText:   "no module owns this template output",
			wantFailed: true,
		},
		{
			name:       "ownership overlap",
			options:    lintTemplateOptions{Overlap: true},
			wantCode:   "ownership_overlap",
			wantText:   "owned by multiple modules",
			wantFailed: false,
		},
		{
			name:       "undeclared placeholder",
			options:    lintTemplateOptions{UndeclaredPlaceholder: true},
			wantCode:   "placeholder_undeclared",
			wantText:   "project.missing",
			wantFailed: true,
		},
		{
			name:       "unused declared value",
			options:    lintTemplateOptions{UnusedValue: true},
			wantCode:   "value_unused",
			wantText:   "declared value is not used",
			wantFailed: false,
		},
		{
			name:       "default cycle",
			options:    lintTemplateOptions{DefaultCycle: true},
			wantCode:   "default_values",
			wantText:   "defaultFrom cycle",
			wantFailed: true,
		},
		{
			name:       "invalid slot",
			options:    lintTemplateOptions{InvalidSlot: true},
			wantCode:   "slot_invalid",
			wantText:   "missing name",
			wantFailed: true,
		},
		{
			name:       "invalid templateignore",
			options:    lintTemplateOptions{InvalidTemplateIgnore: true},
			wantCode:   "templateignore_invalid",
			wantText:   "absolute path pattern",
			wantFailed: true,
		},
		{
			name:       "output collision",
			options:    lintTemplateOptions{OutputCollision: true},
			wantCode:   "template_parse",
			wantText:   "both render to README.md",
			wantFailed: true,
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			templateRoot := writeLintTemplate(t, testCase.options)
			report, err := LintTemplate(templateRoot)
			if err != nil {
				t.Fatalf("LintTemplate returned error: %v", err)
			}
			if report.OK == testCase.wantFailed {
				t.Fatalf("report OK = %t, want failed = %t; findings: %+v", report.OK, testCase.wantFailed, report.Findings)
			}
			assertLintFinding(t, report, testCase.wantCode, testCase.wantText)
		})
	}
}

type lintTemplateOptions struct {
	ExtraTemplateFile     bool
	Overlap               bool
	UndeclaredPlaceholder bool
	UnusedValue           bool
	DefaultCycle          bool
	InvalidSlot           bool
	InvalidTemplateIgnore bool
	OutputCollision       bool
}

func writeLintTemplate(t *testing.T, options lintTemplateOptions) string {
	t.Helper()
	root := t.TempDir()
	ignore := ".templateignore\ntemplate/**\nschema/**\n.slot.yaml\n"
	if options.InvalidTemplateIgnore {
		ignore += "/absolute\n"
	}
	mustWriteFile(t, filepath.Join(root, ".templateignore"), ignore)
	mustWriteFile(t, filepath.Join(root, "schema", "template-manifest.schema.json"), "{}\n")
	mustWriteFile(t, filepath.Join(root, "schema", "template-module.schema.json"), "{}\n")

	modules := "  - modules/core.yaml\n"
	if options.Overlap {
		modules += "  - modules/extra.yaml\n"
		mustWriteFile(t, filepath.Join(root, "template", "modules", "extra.yaml"), "name: extra\ndescription: Extra test module.\nvalues: {}\nowns:\n  - README.md\n")
	}
	mustWriteFile(t, filepath.Join(root, "template", "manifest.yaml"), "name: project-template\nversion: 0.1.0\nmodules:\n"+modules)

	values := "  project.slug:\n    type: string\n    required: true\n"
	if options.UnusedValue {
		values += "  project.unused:\n    type: string\n    required: false\n"
	}
	if options.DefaultCycle {
		values += "  project.name:\n    type: string\n    required: true\n    defaultFrom: project.displayName\n"
		values += "  project.displayName:\n    type: string\n    required: true\n    defaultFrom: project.name\n"
	}
	mustWriteFile(t, filepath.Join(root, "template", "modules", "core.yaml"), "name: core.fullstack\ndescription: Core test module.\ndefault: true\nvalues:\n"+values+"owns:\n  - README.md\n")

	readme := "# {{ project.slug }}\n"
	if options.UndeclaredPlaceholder {
		readme = "# {{ project.missing }}\n"
	}
	mustWriteFile(t, filepath.Join(root, "README.md.template"), readme)
	if options.ExtraTemplateFile {
		mustWriteFile(t, filepath.Join(root, "EXTRA.md.template"), "extra\n")
	}
	if options.OutputCollision {
		mustWriteFile(t, filepath.Join(root, "README.md"), "collision\n")
	}
	if options.InvalidSlot {
		mustWriteFile(t, filepath.Join(root, ".slot.yaml"), "allow:\n  - extras/**\n")
	}
	return root
}

func assertLintFinding(t *testing.T, report TemplateLintReport, code string, text string) {
	t.Helper()
	for _, finding := range report.Findings {
		if finding.Code == code && strings.Contains(finding.Message, text) {
			return
		}
	}
	t.Fatalf("missing lint finding code %q containing %q; findings: %+v", code, text, report.Findings)
}
