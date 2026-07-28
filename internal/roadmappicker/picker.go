package roadmappicker

import (
	"context"
	"errors"
	"io"

	tea "github.com/charmbracelet/bubbletea"
)

var ErrNoCandidates = errors.New("no matching roadmap issues are available")

type Candidate struct {
	Description string
	ID          string
	Title       string
}

type Picker struct{}

func (Picker) Pick(
	ctx context.Context,
	input io.Reader,
	output io.Writer,
	prompt string,
	candidates []Candidate,
) (int, bool, error) {
	if len(candidates) == 0 {
		return 0, false, ErrNoCandidates
	}
	initial := newModel(prompt, candidates)
	program := tea.NewProgram(
		initial,
		tea.WithAltScreen(),
		tea.WithContext(ctx),
		tea.WithInput(input),
		tea.WithOutput(output),
	)
	final, err := program.Run()
	if err != nil {
		return 0, false, err
	}
	result, ok := final.(model)
	if !ok {
		return 0, false, errors.New("roadmap picker returned an invalid result")
	}
	if result.cancelled || result.selected < 0 {
		return 0, false, nil
	}
	return result.selected, true, nil
}
