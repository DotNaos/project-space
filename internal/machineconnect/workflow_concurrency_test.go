package machineconnect

import (
	"context"
	"errors"
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
	revokeCalls   int
	revokeStarted chan struct{}
	releaseRevoke chan struct{}
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

func (backend *concurrentWorkflowBackend) Revoke(ctx context.Context, _ Credential) error {
	backend.mu.Lock()
	backend.revokeCalls++
	started := backend.revokeStarted
	release := backend.releaseRevoke
	backend.mu.Unlock()
	if started != nil {
		close(started)
	}
	if release != nil {
		select {
		case <-release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (backend *concurrentWorkflowBackend) counts() (int, int) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return backend.createCalls, backend.exchangeCalls
}

func TestUninstallBlocksConcurrentConnectUntilRevocationAndPurgeFinish(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native Windows credential locking is covered by DPAPI process tests")
	}
	now := time.Now().UTC()
	backend := &concurrentWorkflowBackend{
		request: Request{
			ID: "request-after-uninstall", PollToken: "poll-secret",
			ApprovalURL: "https://projects.os-home.net/connect/request-after-uninstall",
			ExpiresAt:   now.Add(time.Minute), PollInterval: time.Second,
		},
		credential:    testCredential(now),
		revokeStarted: make(chan struct{}),
		releaseRevoke: make(chan struct{}),
	}
	credentialPath := filepath.Join(t.TempDir(), "machine-credential.json")
	firstStore, err := NewFileStore(credentialPath)
	if err != nil {
		t.Fatalf("new uninstall store: %v", err)
	}
	key := testMachineKey(t)
	if err := firstStore.SaveKey(key); err != nil {
		t.Fatalf("seed machine key: %v", err)
	}
	if err := firstStore.Save(backend.credential); err != nil {
		t.Fatalf("seed machine credential: %v", err)
	}
	secondStore, err := NewFileStore(credentialPath)
	if err != nil {
		t.Fatalf("new connect store: %v", err)
	}
	uninstallWorkflow := newTestWorkflow(
		t, backend, firstStore, &recordingPresenter{}, &recordingConnector{}, RealClock{},
	)
	connectWorkflow := newTestWorkflow(
		t, backend, secondStore, &recordingPresenter{}, &recordingConnector{}, RealClock{},
	)

	uninstallDone := make(chan error, 1)
	go func() {
		_, uninstallErr := uninstallWorkflow.Uninstall(context.Background())
		uninstallDone <- uninstallErr
	}()
	select {
	case <-backend.revokeStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("uninstall did not reach backend revocation")
	}

	connectCtx, cancelConnect := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancelConnect()
	_, connectErr := connectWorkflow.Connect(connectCtx, testMachine())
	if !errors.Is(connectErr, context.DeadlineExceeded) {
		t.Fatalf("concurrent connect error = %v, want credential-lock timeout", connectErr)
	}
	createCalls, exchangeCalls := backend.counts()
	if createCalls != 0 || exchangeCalls != 0 {
		t.Fatalf("concurrent connect reached enrollment: create=%d exchange=%d", createCalls, exchangeCalls)
	}

	close(backend.releaseRevoke)
	select {
	case err := <-uninstallDone:
		if err != nil {
			t.Fatalf("uninstall after revocation release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("uninstall did not finish after revocation release")
	}
	if _, err := firstStore.LoadKey(); !errors.Is(err, ErrMachineKeyNotFound) {
		t.Fatalf("machine identity remained after uninstall: %v", err)
	}
}

func TestConcurrentConnectCreatesOnlyOneMachineIdentity(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native Windows credentials use a DPAPI-protected store; cross-process locking is tested separately")
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
