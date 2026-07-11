package machineconnect

import (
	"context"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
)

type concurrentWorkflowBackend struct {
	mu            sync.Mutex
	request       Request
	credential    Credential
	createCalls   int
	exchangeCalls int
}

func (*concurrentWorkflowBackend) Health(context.Context) error { return nil }

func (backend *concurrentWorkflowBackend) CreateRequest(context.Context, Machine, MachineKey) (Request, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.createCalls++
	return backend.request, nil
}

func (*concurrentWorkflowBackend) PollRequest(context.Context, Request) (Approval, error) {
	return Approval{State: ApprovalApproved, Challenge: "challenge"}, nil
}

func (backend *concurrentWorkflowBackend) Exchange(context.Context, Request, string, MachineKey) (Credential, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.exchangeCalls++
	return backend.credential, nil
}

func (*concurrentWorkflowBackend) Connection(context.Context, Credential) (ConnectionState, error) {
	return ConnectionOnline, nil
}

func (*concurrentWorkflowBackend) Revoke(context.Context, Credential) error { return nil }

func (backend *concurrentWorkflowBackend) counts() (int, int) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return backend.createCalls, backend.exchangeCalls
}

func TestConcurrentConnectCreatesOnlyOneMachineIdentity(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native Windows credentials use Credential Manager; cross-process locking is tested separately")
	}
	now := time.Now().UTC()
	backend := &concurrentWorkflowBackend{
		request: Request{
			ID:           "request-concurrent",
			PollToken:    "poll-secret",
			ApprovalURL:  "https://projects.os-home.net/connect/request-concurrent",
			ExpiresAt:    now.Add(time.Minute),
			PollInterval: time.Second,
		},
		credential: testCredential(now),
	}
	credentialPath := filepath.Join(t.TempDir(), "machine-credential.json")
	workflows := make([]*Workflow, 2)
	for index := range workflows {
		store, err := NewFileStore(credentialPath)
		if err != nil {
			t.Fatalf("new file store: %v", err)
		}
		workflows[index] = newTestWorkflow(
			t,
			backend,
			store,
			&recordingPresenter{},
			&recordingConnector{},
			RealClock{},
		)
	}

	start := make(chan struct{})
	results := make(chan ConnectResult, len(workflows))
	errorsFromConnect := make(chan error, len(workflows))
	var wait sync.WaitGroup
	for _, workflow := range workflows {
		wait.Add(1)
		go func(workflow *Workflow) {
			defer wait.Done()
			<-start
			result, err := workflow.Connect(context.Background(), testMachine())
			if err != nil {
				errorsFromConnect <- err
				return
			}
			results <- result
		}(workflow)
	}
	close(start)
	wait.Wait()
	close(errorsFromConnect)
	close(results)

	for err := range errorsFromConnect {
		t.Fatalf("concurrent connect failed: %v", err)
	}
	var connected, reused int
	for result := range results {
		if result.AlreadyConnected {
			reused++
		} else {
			connected++
		}
	}
	if connected != 1 || reused != 1 {
		t.Fatalf("connect results = new %d, reused %d; want one of each", connected, reused)
	}
	createCalls, exchangeCalls := backend.counts()
	if createCalls != 1 || exchangeCalls != 1 {
		t.Fatalf("backend created %d requests and %d credentials; want one each", createCalls, exchangeCalls)
	}
}
