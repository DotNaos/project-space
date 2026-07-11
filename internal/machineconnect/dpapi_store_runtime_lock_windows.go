//go:build windows

package machineconnect

import (
	"context"
	"errors"
	"fmt"
	"time"
)

func (store *windowsDPAPICredentialStore) connectorRuntimeLockPath() string {
	return store.path + ".runtime.lock"
}

func (store *windowsDPAPICredentialStore) LockConnectorRuntime(
	ctx context.Context,
) (func() error, error) {
	if ctx == nil {
		return nil, errors.New("connector runtime lock context is missing")
	}
	runtimeLock, err := newWindowsConnectorRuntimeLock(store.connectorRuntimeLockPath())
	if err != nil {
		return nil, err
	}
	locked, err := runtimeLock.TryLockContext(ctx, 50*time.Millisecond)
	if err != nil {
		_ = runtimeLock.Close()
		return nil, fmt.Errorf("lock connector runtime: %w", err)
	}
	if !locked {
		_ = runtimeLock.Close()
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("lock connector runtime: %w", err)
		}
		return nil, errors.New("lock connector runtime: lock was not acquired")
	}
	return runtimeLock.Close, nil
}
