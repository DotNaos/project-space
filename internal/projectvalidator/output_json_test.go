package projectvalidator

import (
	"encoding/json"
	"testing"
)

func TestProjectReportJSONMapsEntriesAndSummary(t *testing.T) {
	report := Report{
		ProjectRoot:   "/tmp/demo",
		ProjectName:   "demo",
		TemplateLabel: "fullstack-app@0.3.0",
		OK:            false,
		Structure: []StructureEntry{
			{Path: "README.md", Kind: "file", Status: StatusOK, Code: "template", Note: "template", Module: "core.repo"},
			{Path: "notes.txt", Kind: "file", Status: StatusViolation, Code: "not_allowed", Note: "not_allowed"},
			{Path: "docs/todo.md", Kind: "file", Status: StatusAdded, Code: "slot", Note: "docs", Slot: "docs"},
			{Path: "Makefile", Kind: "file", Status: StatusMissing, Code: "missing", Note: "missing"},
			{Path: "legacy.sh", Kind: "file", Status: StatusWaived, Code: "waived", Note: "kept for migration"},
			{Path: "package.json", Kind: "file", Status: StatusChanged, Code: "template", Note: "template", Module: "core.repo"},
		},
		Files: []FileValidation{
			{
				Path:   "package.json",
				Status: StatusChanged,
				Code:   "template",
				Module: "core.repo",
				Diagnostics: []FileDiagnostic{
					{Path: "/packageManager", Status: StatusViolation, Note: `expected frozen value: "bun@1.3.9"`},
				},
			},
		},
	}

	payload := projectReportJSON(report)
	if payload.ProjectName != "demo" || payload.TemplateLabel != "fullstack-app@0.3.0" {
		t.Fatalf("unexpected header: %+v", payload)
	}
	if payload.OK {
		t.Fatal("payload.OK = true, want false")
	}
	summary := payload.Summary
	if summary.Total != 6 || summary.OK != 1 || summary.Violation != 1 || summary.Added != 1 ||
		summary.Missing != 1 || summary.Waived != 1 || summary.Changed != 1 {
		t.Fatalf("unexpected summary: %+v", summary)
	}
	if len(payload.Structure) != 6 {
		t.Fatalf("got %d structure entries, want 6", len(payload.Structure))
	}
	if payload.Structure[2].Slot != "docs" {
		t.Fatalf("slot not mapped: %+v", payload.Structure[2])
	}
	if len(payload.Files) != 1 || len(payload.Files[0].Diagnostics) != 1 {
		t.Fatalf("file diagnostics not mapped: %+v", payload.Files)
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"projectRoot", "projectName", "templateLabel", "ok", "summary", "structure", "files"} {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("encoded payload missing %q", key)
		}
	}
}

func TestProjectReportJSONEmptyReportKeepsArrays(t *testing.T) {
	encoded, err := json.Marshal(projectReportJSON(Report{OK: true}))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded struct {
		Structure []jsonStructureEntry `json:"structure"`
		Files     []jsonFileValidation `json:"files"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.Structure == nil || decoded.Files == nil {
		t.Fatalf("structure/files must encode as arrays, got %s", encoded)
	}
}
