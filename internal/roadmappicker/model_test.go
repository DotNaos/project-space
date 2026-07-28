package roadmappicker

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func pickerCandidates() []Candidate {
	return []Candidate{
		{ID: "#12", Title: "Alpha issue", Description: "first description"},
		{ID: "#24", Title: "Beta issue", Description: "searchable details"},
	}
}

func TestModelFiltersEveryDisplayedField(t *testing.T) {
	for _, query := range []string{"24", "beta", "details"} {
		current := newModel("Choose", pickerCandidates())
		for _, value := range query {
			next, _ := current.Update(tea.KeyMsg{Runes: []rune{value}, Type: tea.KeyRunes})
			current = next.(model)
		}
		if len(current.filtered) != 1 || current.filtered[0] != 1 {
			t.Fatalf("query %q filtered = %#v", query, current.filtered)
		}
	}
}

func TestModelSelectsAndCancelsWithoutSideEffects(t *testing.T) {
	current := newModel("Choose", pickerCandidates())
	next, _ := current.Update(tea.KeyMsg{Type: tea.KeyDown})
	current = next.(model)
	next, command := current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = next.(model)
	if command == nil || current.selected != 1 || current.cancelled {
		t.Fatalf("selected model = %#v, command = %v", current, command)
	}

	current = newModel("Choose", pickerCandidates())
	next, command = current.Update(tea.KeyMsg{Type: tea.KeyEsc})
	current = next.(model)
	if command == nil || !current.cancelled || current.selected != -1 {
		t.Fatalf("cancelled model = %#v, command = %v", current, command)
	}
}

func TestModelRendersSearchableTableWithinWidth(t *testing.T) {
	current := newModel("Choose dependent issue", pickerCandidates())
	next, _ := current.Update(tea.WindowSizeMsg{Height: 10, Width: 60})
	rendered := next.(model).View()
	for _, value := range []string{
		"Choose dependent issue",
		"Search:",
		"ID",
		"TITLE",
		"DESCRIPTION",
		"#12",
		"Alpha issue",
	} {
		if !strings.Contains(rendered, value) {
			t.Fatalf("rendered table does not contain %q:\n%s", value, rendered)
		}
	}
	for _, line := range strings.Split(rendered, "\n") {
		if len([]rune(line)) > 60 {
			t.Fatalf("line exceeds width: %q", line)
		}
	}
}
