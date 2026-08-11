package projectrun

import "context"

func (manager *Manager) startPortlessRoute(ctx context.Context, state runtimeState) (string, error) {
	unlock, err := acquireFileLock(manager.store.portlessLockPath())
	if err != nil {
		return "", err
	}
	defer unlock()
	return manager.portless.Register(ctx, state.PortlessName, state.LocalPort)
}

func (manager *Manager) stopPortlessRoute(ctx context.Context, state runtimeState) error {
	unlock, err := acquireFileLock(manager.store.portlessLockPath())
	if err != nil {
		return err
	}
	defer unlock()
	return manager.portless.Remove(ctx, state.PortlessName, state.PortlessURL, state.LocalPort)
}
