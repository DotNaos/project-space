package projectvalidator

import "testing"

func TestValidateStructuredFileUsesRenderedFrozenValue(t *testing.T) {
	actual := []byte(`{"name":"demo","packageManager":"bun@1.4.0","scripts":{"dev":"custom"}}`)
	rendered := []byte(`{"name":"demo","packageManager":"bun@1.3.9","scripts":{"dev":"custom"}}`)
	rules := TemplateFileRules{
		Format: "json",
		Entries: []TemplateFileRuleEntry{
			{Path: "/name", Kind: "slot", Pattern: "^[a-z0-9-]+$"},
			{Path: "/packageManager", Kind: "frozen"},
			{Path: "/scripts/*", Kind: "open"},
		},
	}

	diagnostics := validateStructuredFile("package.json", actual, rendered, rules)
	var packageManager FileDiagnostic
	for _, diagnostic := range diagnostics {
		if diagnostic.Path == "/packageManager" {
			packageManager = diagnostic
			break
		}
	}
	if packageManager.Status != StatusViolation {
		t.Fatalf("/packageManager status = %s", packageManager.Status)
	}
	if packageManager.Note != `expected frozen value: "bun@1.3.9"` {
		t.Fatalf("/packageManager note = %q", packageManager.Note)
	}
}

func TestValidateStructuredFileDeniesWildcardEntries(t *testing.T) {
	actual := []byte(`{"dependencies":{"react":"19.0.0"}}`)
	rendered := []byte(`{"dependencies":{}}`)
	rules := TemplateFileRules{
		Format: "json",
		Entries: []TemplateFileRuleEntry{
			{Path: "/dependencies/*", Kind: "deny"},
		},
	}

	diagnostics := validateStructuredFile("package.json", actual, rendered, rules)
	if len(diagnostics) != 1 {
		t.Fatalf("got %d diagnostics, want 1", len(diagnostics))
	}
	if diagnostics[0].Path != "/dependencies/react" || diagnostics[0].Status != StatusViolation {
		t.Fatalf("unexpected diagnostic: %+v", diagnostics[0])
	}
}
