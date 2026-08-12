package machineconnect

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const (
	defaultApprovalTimeout = 10 * time.Minute
	defaultCleanupTimeout  = 15 * time.Second
	defaultOnlineTimeout   = 45 * time.Second
	defaultOnlineInterval  = time.Second
	minimumPollInterval    = 250 * time.Millisecond
	maximumPollInterval    = 10 * time.Second
)

type WorkflowOptions struct {
	ApprovalTimeout time.Duration
	CleanupTimeout  time.Duration
	EnrollmentOnly  bool
	KeyRandom       io.Reader
	OnlineTimeout   time.Duration
	OnlineInterval  time.Duration
}

type Workflow struct {
	backend   Backend
	store     CredentialStore
	presenter ApprovalPresenter
	connector Connector
	clock     Clock
	keyRandom io.Reader
	options   WorkflowOptions
}

type ConnectResult struct {
	MachineID        string
	MachineName      string
	ApprovalURL      string
	AlreadyConnected bool
}

type Status struct {
	Configured  bool
	MachineID   string
	MachineName string
	State       ConnectionState
}

type DoctorResult struct {
	BackendReachable bool            `json:"backendReachable"`
	CredentialFound  bool            `json:"credentialFound"`
	State            ConnectionState `json:"status,omitempty"`
}

type UninstallResult struct {
	RevocationPending bool
}

func NewWorkflow(
	backend Backend,
	store CredentialStore,
	presenter ApprovalPresenter,
	connector Connector,
	clock Clock,
	options WorkflowOptions,
) (*Workflow, error) {
	if backend == nil || store == nil || presenter == nil ||
		(!options.EnrollmentOnly && connector == nil) {
		return nil, errors.New("machine connection workflow dependencies are incomplete")
	}
	if clock == nil {
		clock = RealClock{}
	}
	if options.ApprovalTimeout <= 0 {
		options.ApprovalTimeout = defaultApprovalTimeout
	}
	if options.OnlineTimeout <= 0 {
		options.OnlineTimeout = defaultOnlineTimeout
	}
	if options.CleanupTimeout <= 0 {
		options.CleanupTimeout = defaultCleanupTimeout
	}
	if options.OnlineInterval <= 0 {
		options.OnlineInterval = defaultOnlineInterval
	}
	if options.KeyRandom == nil {
		options.KeyRandom = rand.Reader
	}
	options.OnlineInterval = boundedInterval(options.OnlineInterval)
	return &Workflow{
		backend:   backend,
		store:     store,
		presenter: presenter,
		connector: connector,
		clock:     clock,
		keyRandom: options.KeyRandom,
		options:   options,
	}, nil
}

func (workflow *Workflow) Connect(ctx context.Context, machine Machine) (
	result ConnectResult,
	returnErr error,
) {
	if ctx == nil {
		return ConnectResult{}, errors.New("machine connection context is missing")
	}
	if err := validateMachine(machine); err != nil {
		return ConnectResult{}, err
	}
	release, err := workflow.lockCredentialMutation(ctx)
	if err != nil {
		return ConnectResult{}, err
	}
	defer func() {
		returnErr = errors.Join(returnErr, release())
	}()

	credential, err := workflow.store.Load()
	if err == nil {
		state, connectionErr := workflow.backend.Connection(ctx, credential)
		if connectionErr != nil {
			return ConnectResult{}, connectionErr
		}
		if state != ConnectionRevoked {
			if workflow.options.EnrollmentOnly {
				return workflow.resume(ctx, credential, state)
			}
			if state == ConnectionOffline {
				if err := workflow.preflightConnector(ctx); err != nil {
					return ConnectResult{}, err
				}
			}
			return workflow.resume(ctx, credential, state)
		}
		if deleteErr := workflow.store.Delete(); deleteErr != nil {
			return ConnectResult{}, deleteErr
		}
		err = ErrCredentialNotFound
	}
	if !errors.Is(err, ErrCredentialNotFound) {
		return ConnectResult{}, err
	}
	if !workflow.options.EnrollmentOnly {
		if err := workflow.preflightConnector(ctx); err != nil {
			return ConnectResult{}, err
		}
	}
	if err := workflow.backend.Health(ctx); err != nil {
		return ConnectResult{}, fmt.Errorf("Project Space backend is unavailable: %w", err)
	}
	machineKey, err := workflow.loadOrCreateMachineKey()
	if err != nil {
		return ConnectResult{}, err
	}

	request, err := workflow.backend.CreateRequest(ctx, machine, machineKey)
	if err != nil {
		return ConnectResult{}, err
	}
	if !request.ExpiresAt.After(workflow.clock.Now()) {
		return ConnectResult{}, ErrApprovalExpired
	}
	if err := workflow.presenter.Present(ctx, request.ApprovalURL); err != nil {
		return ConnectResult{}, fmt.Errorf("present machine approval URL: %w", err)
	}

	challenge, err := workflow.waitForApproval(ctx, request)
	if err != nil {
		return ConnectResult{}, err
	}
	credential, err = workflow.backend.Exchange(ctx, request, challenge, machineKey)
	if err != nil {
		return ConnectResult{}, err
	}
	if err := workflow.store.Save(credential); err != nil {
		cleanupCtx, cancelCleanup := workflow.cleanupContext(ctx)
		defer cancelCleanup()
		revokeErr := workflow.backend.Revoke(cleanupCtx, credential)
		if revokeErr != nil {
			return ConnectResult{}, errors.Join(
				err,
				fmt.Errorf("revoke unsaved machine credential: %w", revokeErr),
			)
		}
		return ConnectResult{}, err
	}
	if workflow.options.EnrollmentOnly {
		return ConnectResult{
			MachineID:   credential.MachineID,
			MachineName: credential.MachineName,
			ApprovalURL: request.ApprovalURL,
		}, nil
	}
	if err := workflow.connector.Start(ctx); err != nil {
		return ConnectResult{}, workflow.rollbackFirstConnection(
			ctx,
			credential,
			fmt.Errorf("start machine connector: %w", err),
		)
	}
	if err := workflow.waitUntilOnline(ctx, credential); err != nil {
		return ConnectResult{}, workflow.rollbackFirstConnection(ctx, credential, err)
	}
	return ConnectResult{
		MachineID:   credential.MachineID,
		MachineName: credential.MachineName,
		ApprovalURL: request.ApprovalURL,
	}, nil
}

func (workflow *Workflow) preflightConnector(ctx context.Context) error {
	if preflighter, ok := workflow.connector.(ConnectorPreflighter); ok {
		return preflighter.Preflight(ctx)
	}
	return nil
}

func (workflow *Workflow) rollbackFirstConnection(
	ctx context.Context,
	credential Credential,
	cause error,
) error {
	revokeCtx, cancelRevoke := workflow.cleanupContext(ctx)
	revokeErr := workflow.backend.Revoke(revokeCtx, credential)
	cancelRevoke()
	stopErr := error(nil)
	if !workflow.options.EnrollmentOnly {
		stopCtx, cancelStop := workflow.cleanupContext(ctx)
		stopErr = workflow.connector.Stop(stopCtx)
		cancelStop()
	}
	if revokeErr != nil {
		return errors.Join(cause, stopErr, fmt.Errorf("revoke incomplete machine connection: %w", revokeErr))
	}
	deleteErr := workflow.store.Delete()
	return errors.Join(cause, stopErr, deleteErr)
}

func (workflow *Workflow) cleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), workflow.options.CleanupTimeout)
}

func (workflow *Workflow) loadOrCreateMachineKey() (MachineKey, error) {
	key, err := workflow.store.LoadKey()
	if err == nil {
		return key, nil
	}
	if !errors.Is(err, ErrMachineKeyNotFound) {
		return MachineKey{}, err
	}
	key, err = GenerateMachineKey(workflow.keyRandom)
	if err != nil {
		return MachineKey{}, err
	}
	if err := workflow.store.SaveKey(key); err != nil {
		return MachineKey{}, err
	}
	return key, nil
}

func (workflow *Workflow) Status(ctx context.Context) (Status, error) {
	credential, err := workflow.store.Load()
	if errors.Is(err, ErrCredentialNotFound) {
		return Status{}, nil
	}
	if err != nil {
		return Status{}, err
	}
	state, err := workflow.backend.Connection(ctx, credential)
	if err != nil {
		return Status{}, err
	}
	return Status{
		Configured:  true,
		MachineID:   credential.MachineID,
		MachineName: credential.MachineName,
		State:       state,
	}, nil
}

func (workflow *Workflow) Doctor(ctx context.Context) (DoctorResult, error) {
	if err := workflow.backend.Health(ctx); err != nil {
		return DoctorResult{}, fmt.Errorf("Project Space backend is unavailable: %w", err)
	}
	result := DoctorResult{BackendReachable: true}
	credential, err := workflow.store.Load()
	if errors.Is(err, ErrCredentialNotFound) {
		return result, nil
	}
	if err != nil {
		return DoctorResult{}, err
	}
	result.CredentialFound = true
	result.State, err = workflow.backend.Connection(ctx, credential)
	if err != nil {
		return DoctorResult{}, err
	}
	return result, nil
}

func (workflow *Workflow) Disconnect(ctx context.Context) (returnErr error) {
	release, err := workflow.lockCredentialMutation(ctx)
	if err != nil {
		return err
	}
	defer func() {
		returnErr = errors.Join(returnErr, release())
	}()

	credential, err := workflow.store.Load()
	if errors.Is(err, ErrCredentialNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := workflow.backend.Revoke(ctx, credential); err != nil {
		return err
	}
	stopErr := error(nil)
	if !workflow.options.EnrollmentOnly {
		cleanupCtx, cancelCleanup := workflow.cleanupContext(ctx)
		defer cancelCleanup()
		stopErr = workflow.connector.Stop(cleanupCtx)
	}
	deleteErr := workflow.store.Delete()
	if stopErr != nil || deleteErr != nil {
		return errors.Join(stopErr, deleteErr)
	}
	return nil
}

// Uninstall performs best-effort backend revocation and complete local removal
// under one credential mutation lock. Backend failures do not block an offline
// uninstall, but local service or identity cleanup failures do.
func (workflow *Workflow) Uninstall(ctx context.Context) (
	result UninstallResult,
	returnErr error,
) {
	if ctx == nil {
		return UninstallResult{}, errors.New("machine uninstall context is missing")
	}
	release, err := workflow.lockCredentialMutation(ctx)
	if err != nil {
		return UninstallResult{}, err
	}
	defer func() {
		returnErr = errors.Join(returnErr, release())
	}()

	credential, loadErr := workflow.store.Load()
	switch {
	case loadErr == nil:
		revokeCtx, cancelRevoke := workflow.cleanupContext(ctx)
		if err := workflow.backend.Revoke(revokeCtx, credential); err != nil {
			result.RevocationPending = true
		}
		cancelRevoke()
	case errors.Is(loadErr, ErrCredentialNotFound):
	case loadErr != nil:
		// Corrupt or unreadable local state cannot be revoked safely. Purge it
		// without decoding and tell the caller that server cleanup may remain.
		result.RevocationPending = true
	}

	stopErr := error(nil)
	if !workflow.options.EnrollmentOnly {
		stopCtx, cancelStop := workflow.cleanupContext(ctx)
		stopErr = workflow.connector.Stop(stopCtx)
		cancelStop()
	}
	if stopErr != nil {
		return result, stopErr
	}
	purger, ok := workflow.store.(CredentialPurger)
	if !ok {
		return result, errors.New("machine credential store does not support complete removal")
	}
	runtimeRelease := func() error { return nil }
	if runtimeLocker, ok := workflow.store.(ConnectorRuntimeLocker); ok {
		barrierCtx, cancelBarrier := workflow.cleanupContext(ctx)
		runtimeRelease, err = runtimeLocker.LockConnectorRuntime(barrierCtx)
		cancelBarrier()
		if err != nil {
			return result, err
		}
	}
	purgeErr := purger.Purge()
	releaseErr := runtimeRelease()
	return result, errors.Join(purgeErr, releaseErr)
}

func (workflow *Workflow) lockCredentialMutation(ctx context.Context) (func() error, error) {
	locker, ok := workflow.store.(CredentialLocker)
	if !ok {
		return func() error { return nil }, nil
	}
	return locker.Lock(ctx)
}

func (workflow *Workflow) resume(
	ctx context.Context,
	credential Credential,
	state ConnectionState,
) (ConnectResult, error) {
	if workflow.options.EnrollmentOnly {
		return ConnectResult{
			MachineID:        credential.MachineID,
			MachineName:      credential.MachineName,
			AlreadyConnected: true,
		}, nil
	}
	if state == ConnectionOffline {
		if err := workflow.connector.Start(ctx); err != nil {
			return ConnectResult{}, fmt.Errorf("start machine connector: %w", err)
		}
		if err := workflow.waitUntilOnline(ctx, credential); err != nil {
			return ConnectResult{}, err
		}
	}
	return ConnectResult{
		MachineID:        credential.MachineID,
		MachineName:      credential.MachineName,
		AlreadyConnected: true,
	}, nil
}

func (workflow *Workflow) waitForApproval(ctx context.Context, request Request) (string, error) {
	deadline := workflow.clock.Now().Add(workflow.options.ApprovalTimeout)
	if request.ExpiresAt.Before(deadline) {
		deadline = request.ExpiresAt
	}
	interval := boundedInterval(request.PollInterval)
	for {
		if !workflow.clock.Now().Before(deadline) {
			return "", ErrApprovalExpired
		}
		approval, err := workflow.backend.PollRequest(ctx, request)
		if err != nil {
			return "", err
		}
		switch approval.State {
		case ApprovalApproved:
			return approval.Challenge, nil
		case ApprovalDenied:
			return "", ErrApprovalDenied
		case ApprovalExpired, ApprovalConsumed:
			return "", ErrApprovalExpired
		case ApprovalPending:
			if approval.RetryAfter > 0 {
				interval = boundedInterval(approval.RetryAfter)
			}
		default:
			return "", errors.New("backend returned an invalid approval state")
		}
		if err := workflow.clock.Sleep(ctx, interval); err != nil {
			return "", err
		}
	}
}

func (workflow *Workflow) waitUntilOnline(ctx context.Context, credential Credential) error {
	deadline := workflow.clock.Now().Add(workflow.options.OnlineTimeout)
	for {
		state, err := workflow.backend.Connection(ctx, credential)
		if err != nil {
			return err
		}
		switch state {
		case ConnectionOnline:
			return nil
		case ConnectionRevoked:
			return ErrMachineRevoked
		case ConnectionOffline:
		default:
			return errors.New("backend returned an invalid machine connection state")
		}
		if !workflow.clock.Now().Before(deadline) {
			return errors.New("machine connector did not come online before the timeout")
		}
		if err := workflow.clock.Sleep(ctx, workflow.options.OnlineInterval); err != nil {
			return err
		}
	}
}

func validateMachine(machine Machine) error {
	for field, value := range map[string]string{
		"machine name":     machine.Name,
		"hostname":         machine.Hostname,
		"operating system": machine.OS,
		"architecture":     machine.Architecture,
		"client version":   machine.ClientVersion,
	} {
		if strings.TrimSpace(value) == "" || strings.TrimSpace(value) != value ||
			len(value) > 256 || strings.ContainsAny(value, "\r\n\x00") {
			return fmt.Errorf("%s is invalid", field)
		}
	}
	if !validMachineName(machine.Name) {
		return errors.New("machine name must use letters, numbers, spaces, dots, underscores, or hyphens")
	}
	if !validMachineLabel(machine.Hostname) {
		return errors.New("hostname must use letters, numbers, dots, underscores, or hyphens")
	}
	if machine.OS != "darwin" && machine.OS != "linux" && machine.OS != "windows" {
		return errors.New("operating system is not supported")
	}
	if machine.Architecture != "amd64" && machine.Architecture != "arm64" {
		return errors.New("architecture is not supported")
	}
	if !validClientVersion(machine.ClientVersion) {
		return errors.New("client version is invalid")
	}
	return nil
}

func validMachineName(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for index, character := range value {
		allowed := character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || index > 0 && strings.ContainsRune(" ._-", character)
		if !allowed {
			return false
		}
	}
	return true
}

func validMachineLabel(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for index, character := range value {
		allowed := character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || index > 0 && strings.ContainsRune("._-", character)
		if !allowed {
			return false
		}
	}
	return true
}

func validClientVersion(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune(".+_-", character) {
			continue
		}
		return false
	}
	return true
}

func boundedInterval(interval time.Duration) time.Duration {
	if interval < minimumPollInterval {
		return minimumPollInterval
	}
	if interval > maximumPollInterval {
		return maximumPollInterval
	}
	return interval
}
