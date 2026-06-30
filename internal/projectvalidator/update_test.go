package projectvalidator

import "testing"

func TestPlanTemplateUpdateValuesShowsAddedModuleValues(t *testing.T) {
	current := TemplateValues{
		"project": map[string]any{
			"slug": "demo-project",
		},
	}
	next := TemplateValues{
		"project": map[string]any{
			"slug":    "demo-project",
			"tagline": "Built from demo-project",
		},
	}

	changes := planTemplateUpdateValues(current, next)
	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d: %#v", len(changes), changes)
	}
	change := changes[0]
	if change.Action != "ADD" || change.Key != "project.tagline" || change.After != "Built from demo-project" {
		t.Fatalf("unexpected change: %#v", change)
	}
}

func TestFlattenTemplateValuesHandlesNamedRootType(t *testing.T) {
	values := TemplateValues{
		"project": map[string]any{
			"slug": "demo-project",
		},
	}

	flat := flattenTemplateValues(values)
	if flat["project.slug"] != "demo-project" {
		t.Fatalf("project.slug = %q", flat["project.slug"])
	}
}
