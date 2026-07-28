package roadmappicker

import (
	"fmt"
	"strings"
	"unicode"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/mattn/go-runewidth"
)

const (
	defaultHeight = 16
	defaultWidth  = 100
)

type model struct {
	cancelled  bool
	candidates []Candidate
	cursor     int
	filtered   []int
	height     int
	prompt     string
	query      []rune
	selected   int
	width      int
}

func newModel(prompt string, candidates []Candidate) model {
	result := model{
		candidates: candidates,
		height:     defaultHeight,
		prompt:     prompt,
		selected:   -1,
		width:      defaultWidth,
	}
	result.refilter()
	return result
}

func (model) Init() tea.Cmd {
	return nil
}

func (current model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch typed := message.(type) {
	case tea.WindowSizeMsg:
		current.width = max(40, typed.Width)
		current.height = max(8, typed.Height)
	case tea.KeyMsg:
		switch typed.String() {
		case "ctrl+c", "esc":
			current.cancelled = true
			return current, tea.Quit
		case "enter":
			if len(current.filtered) > 0 {
				current.selected = current.filtered[current.cursor]
				return current, tea.Quit
			}
		case "up", "ctrl+p":
			if current.cursor > 0 {
				current.cursor--
			}
		case "down", "ctrl+n":
			if current.cursor+1 < len(current.filtered) {
				current.cursor++
			}
		case "pgup":
			current.cursor = max(0, current.cursor-current.visibleRows())
		case "pgdown":
			current.cursor = min(
				max(0, len(current.filtered)-1),
				current.cursor+current.visibleRows(),
			)
		case "backspace", "ctrl+h":
			if len(current.query) > 0 {
				current.query = current.query[:len(current.query)-1]
				current.refilter()
			}
		case "ctrl+u":
			current.query = nil
			current.refilter()
		default:
			for _, value := range typed.Runes {
				if !unicode.IsControl(value) {
					current.query = append(current.query, value)
				}
			}
			current.refilter()
		}
	}
	return current, nil
}

func (current model) View() string {
	var output strings.Builder
	fmt.Fprintf(&output, "%s\n\nSearch: %s\n\n", current.prompt, string(current.query))
	idWidth, titleWidth, descriptionWidth := current.columnWidths()
	fmt.Fprintf(
		&output,
		"  %-*s  %-*s  %-*s\n",
		idWidth,
		"ID",
		titleWidth,
		"TITLE",
		descriptionWidth,
		"DESCRIPTION",
	)
	start := 0
	if current.cursor >= current.visibleRows() {
		start = current.cursor - current.visibleRows() + 1
	}
	end := min(len(current.filtered), start+current.visibleRows())
	for row := start; row < end; row++ {
		candidate := current.candidates[current.filtered[row]]
		marker := " "
		if row == current.cursor {
			marker = ">"
		}
		fmt.Fprintf(
			&output,
			"%s %-*s  %-*s  %-*s\n",
			marker,
			idWidth,
			truncate(candidate.ID, idWidth),
			titleWidth,
			truncate(candidate.Title, titleWidth),
			descriptionWidth,
			truncate(candidate.Description, descriptionWidth),
		)
	}
	if len(current.filtered) == 0 {
		output.WriteString("  No matching issues.\n")
	}
	output.WriteString("\nType to filter · ↑/↓ select · Enter confirm · Esc cancel")
	return output.String()
}

func (current *model) refilter() {
	needle := strings.ToLower(strings.TrimSpace(string(current.query)))
	current.filtered = current.filtered[:0]
	for index, candidate := range current.candidates {
		haystack := strings.ToLower(strings.Join(
			[]string{candidate.ID, candidate.Title, candidate.Description},
			"\n",
		))
		if needle == "" || strings.Contains(haystack, needle) {
			current.filtered = append(current.filtered, index)
		}
	}
	if len(current.filtered) == 0 {
		current.cursor = 0
	} else {
		current.cursor = min(current.cursor, len(current.filtered)-1)
	}
}

func (current model) visibleRows() int {
	return max(1, current.height-7)
}

func (current model) columnWidths() (int, int, int) {
	idWidth := 8
	for _, candidate := range current.candidates {
		idWidth = min(24, max(idWidth, runewidth.StringWidth(candidate.ID)))
	}
	remaining := max(24, current.width-idWidth-8)
	titleWidth := max(12, remaining*2/5)
	descriptionWidth := max(12, remaining-titleWidth)
	return idWidth, titleWidth, descriptionWidth
}

func truncate(value string, width int) string {
	value = strings.TrimSpace(value)
	if runewidth.StringWidth(value) <= width {
		return value
	}
	if width <= 1 {
		return "…"
	}
	return runewidth.Truncate(value, width, "…")
}
