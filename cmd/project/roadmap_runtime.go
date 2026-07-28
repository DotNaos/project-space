package main

import (
	"context"
	"errors"
	"io"
	"os"

	"github.com/DotNaos/project-space/internal/machineconnect"
	"github.com/DotNaos/project-space/internal/roadmap"
	"github.com/DotNaos/project-space/internal/roadmappicker"
	"golang.org/x/term"
)

type roadmapCommandRuntime struct {
	client roadmap.API
}

type roadmapCommandDependencies struct {
	Interactive func(io.Reader, io.Writer) bool
	LoadRuntime func(context.Context) (roadmapCommandRuntime, error)
	PickIssue   func(
		context.Context,
		io.Reader,
		io.Writer,
		string,
		[]roadmap.Issue,
		string,
	) (roadmap.Issue, bool, error)
	ResolveRepository func(context.Context) (string, error)
	TerminalWidth     func(io.Writer) int
}

func defaultRoadmapCommandDependencies() roadmapCommandDependencies {
	return roadmapCommandDependencies{
		Interactive:       roadmapTerminalInteractive,
		LoadRuntime:       loadRoadmapCommandRuntime,
		PickIssue:         pickRoadmapIssueInTerminal,
		ResolveRepository: resolveCurrentGitHubRepository,
		TerminalWidth:     roadmapTerminalWidth,
	}
}

func roadmapInteractive(
	dependencies roadmapCommandDependencies,
	input io.Reader,
	output io.Writer,
) bool {
	return dependencies.Interactive != nil && dependencies.Interactive(input, output)
}

func roadmapOutputWidth(
	dependencies roadmapCommandDependencies,
	output io.Writer,
) int {
	if dependencies.TerminalWidth == nil {
		return fallbackRoadmapOutputWidth
	}
	return max(40, dependencies.TerminalWidth(output))
}

func roadmapTerminalInteractive(input io.Reader, output io.Writer) bool {
	inputFile, inputOK := input.(*os.File)
	outputFile, outputOK := output.(*os.File)
	return inputOK && outputOK &&
		term.IsTerminal(int(inputFile.Fd())) &&
		term.IsTerminal(int(outputFile.Fd()))
}

func roadmapTerminalWidth(output io.Writer) int {
	outputFile, ok := output.(*os.File)
	if !ok || !term.IsTerminal(int(outputFile.Fd())) {
		return fallbackRoadmapOutputWidth
	}
	width, _, err := term.GetSize(int(outputFile.Fd()))
	if err != nil || width < 1 {
		return fallbackRoadmapOutputWidth
	}
	return width
}

func pickRoadmapIssueInTerminal(
	ctx context.Context,
	input io.Reader,
	output io.Writer,
	prompt string,
	issues []roadmap.Issue,
	localRepository string,
) (roadmap.Issue, bool, error) {
	candidates := make([]roadmappicker.Candidate, len(issues))
	for index, issue := range issues {
		candidates[index] = roadmappicker.Candidate{
			Description: normalizedRoadmapDescription(issue.Description),
			ID: roadmapIssueLabel(
				issue.Repository,
				issue.Number,
				localRepository,
			),
			Title: normalizedRoadmapText(issue.Title),
		}
	}
	selected, ok, err := (roadmappicker.Picker{}).Pick(
		ctx,
		input,
		output,
		prompt,
		candidates,
	)
	if err != nil || !ok {
		return roadmap.Issue{}, false, err
	}
	return issues[selected], true, nil
}

func loadRoadmapCommandRuntime(_ context.Context) (roadmapCommandRuntime, error) {
	store, err := machineconnect.NewDefaultCredentialStore()
	if err != nil {
		return roadmapCommandRuntime{}, errors.New("load Project machine connection")
	}
	credential, err := store.Load()
	if err != nil {
		return roadmapCommandRuntime{}, errors.New(
			"this machine is not connected to Project Space",
		)
	}
	token := credential.Token
	client, err := roadmap.NewClient(roadmap.Config{
		BaseURL:         credential.BackendURL,
		CallerMachineID: credential.MachineID,
		CredentialProvider: roadmap.CredentialProviderFunc(
			func(context.Context) (string, error) { return token, nil },
		),
	})
	if err != nil {
		return roadmapCommandRuntime{}, err
	}
	return roadmapCommandRuntime{client: client}, nil
}
