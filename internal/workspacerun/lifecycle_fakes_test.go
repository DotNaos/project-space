package workspacerun

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"time"

	"github.com/DotNaos/project-space/internal/projectrun"
)

type ledgerLifecycleProject struct {
	session    projectrun.ServeResult
	stops      int
	observeErr error
	errorCount int
}

type rollbackLifecycleProject struct {
	directory   string
	workspaceID string
	generation  string
	sessions    map[string]projectrun.ServeResult
	failFirst   bool
	starts      int
}

type uncertainLifecycleProject struct {
	sessions      map[string]projectrun.ServeResult
	failStartName string
	observeErr    error
	stops         int
}

func newUncertainLifecycleProject() *uncertainLifecycleProject {
	return &uncertainLifecycleProject{sessions: map[string]projectrun.ServeResult{}}
}

func (*uncertainLifecycleProject) PrepareExpected(context.Context, string, string, projectrun.SetupExpectations, projectrun.Streams) (projectrun.SetupCollectionResult, error) {
	return projectrun.SetupCollectionResult{}, nil
}
func (*uncertainLifecycleProject) RunWithOptions(context.Context, string, string, projectrun.Streams, projectrun.RunOptions) (projectrun.RunResult, error) {
	return projectrun.RunResult{}, nil
}
func (project *uncertainLifecycleProject) StartWithOptions(_ context.Context, directory, name string, options projectrun.StartOptions) (projectrun.ServeResult, error) {
	if name == project.failStartName {
		return projectrun.ServeResult{}, errors.New("uncertain dev-server start")
	}
	result := projectrun.ServeResult{
		Script: name, Directory: directory, WorkspaceID: options.WorkspaceID,
		RuntimeGeneration: options.RuntimeGeneration, ServerID: "server-" + name,
		TmuxSession: "tmux-" + name, State: projectrun.StateRunning,
	}
	project.sessions[name] = result
	return result, nil
}
func (project *uncertainLifecycleProject) ObserveSessions(context.Context) (projectrun.ServeCollectionResult, error) {
	sessions := make([]projectrun.ServeResult, 0, len(project.sessions))
	for _, session := range project.sessions {
		sessions = append(sessions, session)
	}
	return projectrun.ServeCollectionResult{Sessions: sessions, ErrorCount: boolInt(project.observeErr != nil)}, project.observeErr
}
func (project *uncertainLifecycleProject) Status(_ context.Context, _ string, name string) (projectrun.ServeResult, error) {
	result, present := project.sessions[name]
	if !present {
		return projectrun.ServeResult{}, errors.New("session is absent")
	}
	return result, nil
}
func (project *uncertainLifecycleProject) StopExpected(_ context.Context, _, name, _, _ string) (projectrun.ServeResult, error) {
	project.stops++
	result := project.sessions[name]
	delete(project.sessions, name)
	result.State = projectrun.StateStopped
	return result, nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func newRollbackLifecycleProject(record runtimeRecord) *rollbackLifecycleProject {
	project := &rollbackLifecycleProject{
		directory: record.Directory, workspaceID: record.WorkspaceID, generation: record.Generation,
		sessions: map[string]projectrun.ServeResult{}, failFirst: true,
	}
	for _, server := range record.DevServers {
		project.sessions[server.Name] = project.result(server.Name)
	}
	return project
}

func (project *rollbackLifecycleProject) result(name string) projectrun.ServeResult {
	return projectrun.ServeResult{
		Script: name, Directory: project.directory, WorkspaceID: project.workspaceID,
		RuntimeGeneration: project.generation, ServerID: "server-" + name,
		TmuxSession: "tmux-" + name, State: projectrun.StateRunning,
	}
}

func (*rollbackLifecycleProject) PrepareExpected(context.Context, string, string, projectrun.SetupExpectations, projectrun.Streams) (projectrun.SetupCollectionResult, error) {
	return projectrun.SetupCollectionResult{}, nil
}
func (*rollbackLifecycleProject) RunWithOptions(context.Context, string, string, projectrun.Streams, projectrun.RunOptions) (projectrun.RunResult, error) {
	return projectrun.RunResult{}, nil
}
func (project *rollbackLifecycleProject) StartWithOptions(_ context.Context, _ string, name string, _ projectrun.StartOptions) (projectrun.ServeResult, error) {
	project.starts++
	result := project.result(name)
	project.sessions[name] = result
	return result, nil
}
func (project *rollbackLifecycleProject) ObserveSessions(context.Context) (projectrun.ServeCollectionResult, error) {
	sessions := make([]projectrun.ServeResult, 0, len(project.sessions))
	for _, name := range []string{"first", "second"} {
		if session, present := project.sessions[name]; present {
			sessions = append(sessions, session)
		}
	}
	return projectrun.ServeCollectionResult{Sessions: sessions}, nil
}
func (project *rollbackLifecycleProject) Status(_ context.Context, _ string, name string) (projectrun.ServeResult, error) {
	result, present := project.sessions[name]
	if !present {
		return projectrun.ServeResult{}, errors.New("session is absent")
	}
	return result, nil
}
func (project *rollbackLifecycleProject) StopExpected(_ context.Context, _ string, name, _, _ string) (projectrun.ServeResult, error) {
	result := project.sessions[name]
	delete(project.sessions, name)
	result.State = projectrun.StateStopped
	if name == "first" && project.failFirst {
		project.failFirst = false
		return result, errors.New("cleanup failed after exact server stop")
	}
	return result, nil
}

func (*ledgerLifecycleProject) PrepareExpected(context.Context, string, string, projectrun.SetupExpectations, projectrun.Streams) (projectrun.SetupCollectionResult, error) {
	return projectrun.SetupCollectionResult{}, nil
}
func (*ledgerLifecycleProject) RunWithOptions(context.Context, string, string, projectrun.Streams, projectrun.RunOptions) (projectrun.RunResult, error) {
	return projectrun.RunResult{}, nil
}
func (*ledgerLifecycleProject) StartWithOptions(context.Context, string, string, projectrun.StartOptions) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{}, errors.New("unexpected start")
}
func (project *ledgerLifecycleProject) ObserveSessions(context.Context) (projectrun.ServeCollectionResult, error) {
	sessions := []projectrun.ServeResult{}
	if project.session.ServerID != "" {
		sessions = append(sessions, project.session)
	}
	return projectrun.ServeCollectionResult{Sessions: sessions, ErrorCount: project.errorCount}, project.observeErr
}
func (project *ledgerLifecycleProject) Status(context.Context, string, string) (projectrun.ServeResult, error) {
	if project.session.ServerID == "" {
		return projectrun.ServeResult{}, errors.New("session is absent")
	}
	return project.session, nil
}
func (project *ledgerLifecycleProject) StopExpected(context.Context, string, string, string, string) (projectrun.ServeResult, error) {
	project.stops++
	stopped := project.session
	project.session = projectrun.ServeResult{}
	stopped.State = projectrun.StateStopped
	return stopped, nil
}

type preflightLifecycleProject struct {
	workspaceID string
	generation  string
	stops       int
}

func (*preflightLifecycleProject) PrepareExpected(context.Context, string, string, projectrun.SetupExpectations, projectrun.Streams) (projectrun.SetupCollectionResult, error) {
	return projectrun.SetupCollectionResult{}, nil
}
func (*preflightLifecycleProject) RunWithOptions(context.Context, string, string, projectrun.Streams, projectrun.RunOptions) (projectrun.RunResult, error) {
	return projectrun.RunResult{}, nil
}
func (*preflightLifecycleProject) StartWithOptions(context.Context, string, string, projectrun.StartOptions) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{}, errors.New("unexpected start")
}
func (*preflightLifecycleProject) ObserveSessions(context.Context) (projectrun.ServeCollectionResult, error) {
	return projectrun.ServeCollectionResult{Sessions: []projectrun.ServeResult{}}, nil
}
func (project *preflightLifecycleProject) Status(_ context.Context, _ string, name string) (projectrun.ServeResult, error) {
	state := projectrun.StateRunning
	var lastError *string
	if name == "foreign" {
		state = projectrun.StateError
		message := "foreign ownership"
		lastError = &message
	}
	return projectrun.ServeResult{
		WorkspaceID: project.workspaceID, RuntimeGeneration: project.generation,
		ServerID: "server-" + name, TmuxSession: "tmux-" + name, State: state, LastError: lastError,
	}, nil
}
func (project *preflightLifecycleProject) StopExpected(context.Context, string, string, string, string) (projectrun.ServeResult, error) {
	project.stops++
	return projectrun.ServeResult{}, nil
}

func (*countingLifecycleProject) PrepareExpected(context.Context, string, string, projectrun.SetupExpectations, projectrun.Streams) (projectrun.SetupCollectionResult, error) {
	return projectrun.SetupCollectionResult{}, nil
}
func (*countingLifecycleProject) RunWithOptions(context.Context, string, string, projectrun.Streams, projectrun.RunOptions) (projectrun.RunResult, error) {
	return projectrun.RunResult{}, nil
}
func (*countingLifecycleProject) StartWithOptions(context.Context, string, string, projectrun.StartOptions) (projectrun.ServeResult, error) {
	return projectrun.ServeResult{}, errors.New("unexpected dev-server start")
}
func (*countingLifecycleProject) ObserveSessions(context.Context) (projectrun.ServeCollectionResult, error) {
	return projectrun.ServeCollectionResult{Sessions: []projectrun.ServeResult{}}, nil
}
func (project *countingLifecycleProject) Status(context.Context, string, string) (projectrun.ServeResult, error) {
	project.statuses++
	return projectrun.ServeResult{}, errors.New("unexpected dev-server status")
}
func (project *countingLifecycleProject) StopExpected(context.Context, string, string, string, string) (projectrun.ServeResult, error) {
	project.stops++
	return projectrun.ServeResult{}, errors.New("unexpected dev-server stop")
}

type lifecycleProvider struct {
	starts          int
	stops           int
	suspends        int
	cleans          int
	exists          bool
	owned           bool
	running         bool
	suspended       bool
	handle          RuntimeHandle
	binding         RuntimeBinding
	failAfterCommit bool
}

func (*lifecycleProvider) Mode() Mode { return ModeProcess }

func (provider *lifecycleProvider) Start(_ context.Context, request LaunchRequest) (RuntimeHandle, error) {
	provider.starts++
	provider.binding = request.Binding
	provider.handle = RuntimeHandle{
		Kind: ResourceProcess,
		Process: &ProcessHandle{
			PID: 4242, Identity: strings.Repeat("d", 64), BindingDigest: bindingDigest(request.Binding),
			AppServerSocket: appServerSocketPath(request.Binding),
		},
	}
	provider.exists, provider.owned, provider.running, provider.suspended = true, true, true, false
	if err := request.Commit(provider.handle); err != nil {
		return RuntimeHandle{}, err
	}
	if provider.failAfterCommit {
		provider.exists, provider.running = false, false
		return RuntimeHandle{}, errors.New("fixture failed after commit")
	}
	return provider.handle, nil
}

func (provider *lifecycleProvider) Inspect(_ context.Context, handle RuntimeHandle, binding RuntimeBinding) (ProviderObservation, error) {
	if !reflect.DeepEqual(handle, provider.handle) || binding != provider.binding {
		return ProviderObservation{}, errors.New("runtime binding changed")
	}
	return ProviderObservation{Exists: provider.exists, Owned: provider.owned, Running: provider.running, Suspended: provider.suspended, Handle: provider.handle}, nil
}
func (provider *lifecycleProvider) Suspend(context.Context, RuntimeHandle, RuntimeBinding) error {
	provider.suspends++
	provider.running, provider.suspended = false, true
	return nil
}
func (provider *lifecycleProvider) Resume(context.Context, RuntimeHandle, RuntimeBinding) error {
	provider.running, provider.suspended = true, false
	return nil
}
func (provider *lifecycleProvider) Stop(_ context.Context, handle RuntimeHandle, binding RuntimeBinding, _ time.Duration) error {
	if !reflect.DeepEqual(handle, provider.handle) || binding != provider.binding || !provider.owned {
		return errors.New("refusing changed runtime ownership")
	}
	provider.stops++
	provider.exists, provider.running, provider.suspended = false, false, false
	return nil
}
func (provider *lifecycleProvider) Clean(_ context.Context, handle RuntimeHandle, binding RuntimeBinding) error {
	if !reflect.DeepEqual(handle, provider.handle) || binding != provider.binding || provider.exists {
		return errors.New("refusing changed or live runtime")
	}
	provider.cleans++
	return nil
}
