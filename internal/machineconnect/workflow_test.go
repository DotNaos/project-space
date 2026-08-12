package machineconnect

import (
	"context"
	"crypto/rand"
	"errors"
	"reflect"
	"testing"
	"time"
)

type fakeBackend struct {
	healthErr       error
	request         Request
	approvals       []Approval
	credential      Credential
	connections     []ConnectionState
	revokeErr       error
	exchangeHook    func()
	revokeHook      func()
	revokeCtxErr    error
	healthCalls     int
	createCalls     int
	pollCalls       int
	exchangeCalls   int
	connectionCalls int
	revokeCalls     int
	exchangedCode   string
}

func (backend *fakeBackend) Health(context.Context) error {
	backend.healthCalls++
	return backend.healthErr
}

func (backend *fakeBackend) CreateRequest(context.Context, Machine, MachineKey) (Request, error) {
	backend.createCalls++
	return backend.request, nil
}

func (backend *fakeBackend) PollRequest(context.Context, Request) (Approval, error) {
	backend.pollCalls++
	index := backend.pollCalls - 1
	if index >= len(backend.approvals) {
		index = len(backend.approvals) - 1
	}
	return backend.approvals[index], nil
}

func (backend *fakeBackend) Exchange(_ context.Context, _ Request, exchangeCode string, _ MachineKey) (Credential, error) {
	backend.exchangeCalls++
	backend.exchangedCode = exchangeCode
	if backend.exchangeHook != nil {
		backend.exchangeHook()
	}
	return backend.credential, nil
}

func (backend *fakeBackend) Connection(context.Context, Credential) (ConnectionState, error) {
	backend.connectionCalls++
	index := backend.connectionCalls - 1
	if index >= len(backend.connections) {
		index = len(backend.connections) - 1
	}
	return backend.connections[index], nil
}

func (backend *fakeBackend) Revoke(ctx context.Context, _ Credential) error {
	backend.revokeCalls++
	backend.revokeCtxErr = ctx.Err()
	if backend.revokeHook != nil {
		backend.revokeHook()
	}
	return backend.revokeErr
}

type memoryStore struct {
	credential  *Credential
	key         *MachineKey
	saveErr     error
	saveCalls   int
	deleteCalls int
	purgeCalls  int
	purgeErr    error
}

func (store *memoryStore) LoadKey() (MachineKey, error) {
	if store.key == nil {
		return MachineKey{}, ErrMachineKeyNotFound
	}
	return *store.key, nil
}

func (store *memoryStore) SaveKey(key MachineKey) error {
	store.key = &key
	return nil
}

func (store *memoryStore) Load() (Credential, error) {
	if store.credential == nil {
		return Credential{}, ErrCredentialNotFound
	}
	return *store.credential, nil
}

func (store *memoryStore) Save(credential Credential) error {
	store.saveCalls++
	if store.saveErr != nil {
		return store.saveErr
	}
	store.credential = &credential
	return nil
}

func (store *memoryStore) Delete() error {
	store.deleteCalls++
	store.credential = nil
	return nil
}

func (store *memoryStore) Purge() error {
	store.purgeCalls++
	if store.purgeErr != nil {
		return store.purgeErr
	}
	store.credential = nil
	store.key = nil
	return nil
}

type recordingPresenter struct {
	urls []string
}

func (presenter *recordingPresenter) Present(_ context.Context, approvalURL string) error {
	presenter.urls = append(presenter.urls, approvalURL)
	return nil
}

type fakeClock struct {
	now    time.Time
	sleeps []time.Duration
}

func (clock *fakeClock) Now() time.Time { return clock.now }

func (clock *fakeClock) Sleep(_ context.Context, duration time.Duration) error {
	clock.sleeps = append(clock.sleeps, duration)
	clock.now = clock.now.Add(duration)
	return nil
}

func TestWorkflowConnectCompletesBackendMediatedApproval(t *testing.T) {
	now := time.Date(2026, 7, 11, 12, 0, 0, 0, time.UTC)
	request := Request{
		ID:           "request-1",
		PollToken:    "poll-secret",
		ApprovalURL:  "https://projects.os-home.net/connect/request-1",
		ExpiresAt:    now.Add(time.Minute),
		PollInterval: time.Millisecond,
	}
	credential := testCredential(now)
	backend := &fakeBackend{
		request: request,
		approvals: []Approval{
			{State: ApprovalPending, RetryAfter: 20 * time.Millisecond},
			{State: ApprovalApproved, Challenge: "one-time-code"},
		},
		credential: credential,
	}
	store := &memoryStore{}
	presenter := &recordingPresenter{}
	clock := &fakeClock{now: now}
	workflow := newTestWorkflow(t, backend, store, presenter, clock)

	result, err := workflow.Connect(context.Background(), testMachine())
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if result.MachineID != credential.MachineID || result.MachineName != credential.MachineName {
		t.Fatalf("unexpected result: %#v", result)
	}
	if backend.healthCalls != 1 || backend.createCalls != 1 || backend.pollCalls != 2 || backend.exchangeCalls != 1 {
		t.Fatalf("unexpected backend calls: %#v", backend)
	}
	if backend.exchangedCode != "one-time-code" {
		t.Fatalf("exchange code mismatch: %q", backend.exchangedCode)
	}
	if !reflect.DeepEqual(presenter.urls, []string{request.ApprovalURL}) {
		t.Fatalf("approval URL mismatch: %#v", presenter.urls)
	}
	if store.saveCalls != 1 || store.credential == nil {
		t.Fatalf("credential was not saved exactly once")
	}
	if len(clock.sleeps) != 1 || clock.sleeps[0] != minimumPollInterval {
		t.Fatalf("poll intervals were not bounded: %#v", clock.sleeps)
	}
}

func TestWorkflowConnectIsIdempotentForOnlineCredential(t *testing.T) {
	now := time.Now().UTC()
	credential := testCredential(now)
	backend := &fakeBackend{connections: []ConnectionState{ConnectionOnline}}
	store := &memoryStore{credential: &credential}
	workflow := newTestWorkflow(t, backend, store, &recordingPresenter{}, &fakeClock{now: now})

	result, err := workflow.Connect(context.Background(), testMachine())
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if !result.AlreadyConnected || backend.createCalls != 0 || backend.healthCalls != 0 {
		t.Fatalf("existing connection was not reused: %#v", result)
	}
	if store.saveCalls != 0 {
		t.Fatalf("existing credential was rewritten")
	}
}

func TestWorkflowConnectReauthorizesRevokedCredential(t *testing.T) {
	now := time.Now().UTC()
	oldCredential := testCredential(now.Add(-time.Hour))
	newCredential := testCredential(now)
	newCredential.MachineID = "machine-2"
	backend := &fakeBackend{
		request: Request{
			ID: "request-2", PollToken: "poll-secret", ApprovalURL: "https://projects.os-home.net/connect/request-2",
			ExpiresAt: now.Add(time.Minute), PollInterval: time.Second,
		},
		approvals:   []Approval{{State: ApprovalApproved, Challenge: "code-2"}},
		credential:  newCredential,
		connections: []ConnectionState{ConnectionRevoked},
	}
	store := &memoryStore{credential: &oldCredential}
	workflow := newTestWorkflow(t, backend, store, &recordingPresenter{}, &fakeClock{now: now})

	result, err := workflow.Connect(context.Background(), testMachine())
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if result.MachineID != "machine-2" || store.deleteCalls != 1 || store.saveCalls != 1 {
		t.Fatalf("revoked credential was not replaced: result=%#v store=%#v", result, store)
	}
}

func TestWorkflowDoesNotPersistDeniedApproval(t *testing.T) {
	now := time.Now().UTC()
	backend := &fakeBackend{
		request: Request{
			ID: "request-3", PollToken: "poll-secret", ApprovalURL: "https://projects.os-home.net/connect/request-3",
			ExpiresAt: now.Add(time.Minute), PollInterval: time.Second,
		},
		approvals: []Approval{{State: ApprovalDenied}},
	}
	store := &memoryStore{}
	workflow := newTestWorkflow(t, backend, store, &recordingPresenter{}, &fakeClock{now: now})

	_, err := workflow.Connect(context.Background(), testMachine())
	if !errors.Is(err, ErrApprovalDenied) {
		t.Fatalf("expected approval denied, got %v", err)
	}
	if store.saveCalls != 0 || backend.exchangeCalls != 0 {
		t.Fatalf("denied approval produced local state")
	}
}

func TestWorkflowRevokesCredentialThatCannotBeSaved(t *testing.T) {
	now := time.Now().UTC()
	backend := &fakeBackend{
		request: Request{
			ID: "request-save-failure", PollToken: "poll-secret",
			ApprovalURL: "https://projects.os-home.net/connect/request-save-failure",
			ExpiresAt:   now.Add(time.Minute), PollInterval: time.Second,
		},
		approvals:  []Approval{{State: ApprovalApproved, Challenge: "challenge"}},
		credential: testCredential(now),
	}
	store := &memoryStore{saveErr: errors.New("secure storage unavailable")}
	workflow := newTestWorkflow(t, backend, store, &recordingPresenter{}, &fakeClock{now: now})

	if _, err := workflow.Connect(context.Background(), testMachine()); err == nil {
		t.Fatal("expected secure storage failure")
	}
	if backend.revokeCalls != 1 || store.credential != nil {
		t.Fatalf("unsaved credential was not revoked: backend=%#v store=%#v", backend, store)
	}
}

func TestWorkflowCleanupSurvivesCancellationAfterExchange(t *testing.T) {
	now := time.Now().UTC()
	ctx, cancel := context.WithCancel(context.Background())
	backend := &fakeBackend{
		request: Request{
			ID: "request-cancelled-cleanup", PollToken: "poll-secret",
			ApprovalURL: "https://projects.os-home.net/connect/request-cancelled-cleanup",
			ExpiresAt:   now.Add(time.Minute), PollInterval: time.Second,
		},
		approvals:    []Approval{{State: ApprovalApproved, Challenge: "challenge"}},
		credential:   testCredential(now),
		exchangeHook: cancel,
	}
	store := &memoryStore{}
	workflow := newTestWorkflow(t, backend, store, &recordingPresenter{}, &fakeClock{now: now})

	if _, err := workflow.Connect(ctx, testMachine()); err != nil {
		t.Fatalf("connect after exchange: %v", err)
	}
	if backend.revokeCalls != 0 || store.credential == nil || store.deleteCalls != 0 {
		t.Fatalf("issued credential was not preserved: backend=%#v store=%#v", backend, store)
	}
}

func TestWorkflowDisconnectFinishesLocalCleanupAfterRevocation(t *testing.T) {
	now := time.Now().UTC()
	credential := testCredential(now)
	ctx, cancel := context.WithCancel(context.Background())
	store := &memoryStore{credential: &credential}
	backend := &fakeBackend{revokeHook: cancel}
	workflow := newTestWorkflow(t, backend, store, &recordingPresenter{}, &fakeClock{now: now})

	if err := workflow.Disconnect(ctx); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if store.credential != nil {
		t.Fatalf("disconnect did not delete the credential: store=%#v", store)
	}
}

func TestWorkflowUninstallPurgesIdentityWhenBackendIsOffline(t *testing.T) {
	now := time.Now().UTC()
	credential := testCredential(now)
	key := testMachineKey(t)
	store := &memoryStore{credential: &credential, key: &key}
	backend := &fakeBackend{revokeErr: errors.New("backend unavailable")}
	workflow := newTestWorkflow(t, backend, store, &recordingPresenter{}, &fakeClock{now: now})

	result, err := workflow.Uninstall(context.Background())
	if err != nil {
		t.Fatalf("offline uninstall: %v", err)
	}
	if !result.RevocationPending {
		t.Fatal("offline uninstall did not report pending server revocation")
	}
	if store.credential != nil || store.key != nil || store.purgeCalls != 1 {
		t.Fatalf("offline uninstall did not purge identity: %#v", store)
	}
	if backend.revokeCalls != 1 {
		t.Fatalf("offline uninstall lifecycle = backend %#v", backend)
	}
}

func TestWorkflowUninstallPurgesUnreadableStateWithoutDecoding(t *testing.T) {
	now := time.Now().UTC()
	loadErr := errors.New("protected state is corrupt")
	store := &memoryStore{purgeErr: nil}
	storeWithLoadError := &loadErrorCredentialStore{memoryStore: store, loadErr: loadErr}
	backend := &fakeBackend{}
	workflow := newTestWorkflow(t, backend, storeWithLoadError, &recordingPresenter{}, &fakeClock{now: now})

	result, err := workflow.Uninstall(context.Background())
	if err != nil {
		t.Fatalf("uninstall unreadable state: %v", err)
	}
	if !result.RevocationPending || store.purgeCalls != 1 || backend.revokeCalls != 0 {
		t.Fatalf("unreadable uninstall result = %#v store %#v backend %#v", result, store, backend)
	}
}

type loadErrorCredentialStore struct {
	*memoryStore
	loadErr error
}

func (store *loadErrorCredentialStore) Load() (Credential, error) {
	return Credential{}, store.loadErr
}

func newTestWorkflow(
	t *testing.T,
	backend Backend,
	store CredentialStore,
	presenter ApprovalPresenter,
	clock Clock,
) *Workflow {
	t.Helper()
	workflow, err := NewWorkflow(backend, store, presenter, clock, WorkflowOptions{
		ApprovalTimeout: time.Minute,
	})
	if err != nil {
		t.Fatalf("new workflow: %v", err)
	}
	return workflow
}

func testMachine() Machine {
	return Machine{Name: "os-pc", Hostname: "os-pc", OS: "linux", Architecture: "amd64", ClientVersion: "dev"}
}

func testCredential(issuedAt time.Time) Credential {
	return Credential{
		BackendURL:  "https://projects.os-home.net",
		MachineID:   "machine-1",
		MachineName: "OS PC",
		Token:       "machine-secret",
		IssuedAt:    issuedAt,
	}
}

func testMachineKey(t *testing.T) MachineKey {
	t.Helper()
	key, err := GenerateMachineKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate machine key: %v", err)
	}
	return key
}
