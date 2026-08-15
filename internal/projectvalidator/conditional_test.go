package projectvalidator

import "testing"

func TestRenderConditionalTemplateBodySupportsUnless(t *testing.T) {
	body := []byte("before\n{{#unless app.devices.web.desktop}}\nno desktop\n{{/unless}}\nafter\n")
	rendered, err := renderConditionalTemplateBody(body, TemplateValues{
		"app": map[string]any{"devices": map[string]any{"web": map[string]any{"desktop": false}}},
	})
	if err != nil {
		t.Fatalf("renderConditionalTemplateBody returned error: %v", err)
	}
	if got := string(rendered); got != "before\nno desktop\nafter\n" {
		t.Fatalf("rendered = %q", got)
	}
}
