package machineconnect

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

func (connector *ServiceConnector) startSystemd(ctx context.Context) error {
	loaded, err := connector.systemdUnitLoaded(ctx)
	if err != nil {
		return err
	}
	if loaded {
		// Start is called only when the backend says the connector is offline.
		// Recreate even an active unit so credential rotation and Homebrew
		// upgrades cannot leave an old supervisor process pinned in memory.
		if err := connector.removeSystemdUnit(ctx); err != nil {
			return err
		}
	}

	arguments := []string{
		"--user",
		"--unit=" + machineConnectorSystemdUnit,
		"--collect",
		"--property=Type=exec",
		"--property=Restart=on-failure",
		"--property=RestartSec=5s",
		"--property=UMask=0077",
		"--property=NoNewPrivileges=true",
		"--property=PrivateTmp=true",
		"--",
		connector.executable,
		"connector",
		"run",
	}
	_, runErr := connector.runner.Run(ctx, "systemd-run", arguments...)
	if runErr == nil {
		return nil
	}
	if commandUnavailable(runErr) || ctx.Err() != nil {
		return fmt.Errorf("start machine connector systemd service: %w", runErr)
	}

	// A concurrent idempotent Start may have won after our initial inspection.
	if _, activeErr := connector.runner.Run(
		ctx,
		"systemctl",
		"--user",
		"is-active",
		"--quiet",
		machineConnectorSystemdUnit,
	); activeErr == nil {
		return nil
	}
	return fmt.Errorf("start machine connector systemd service: %w", runErr)
}

func (connector *ServiceConnector) stopSystemd(ctx context.Context) error {
	loaded, err := connector.systemdUnitLoaded(ctx)
	if err != nil || !loaded {
		return err
	}
	return connector.removeSystemdUnit(ctx)
}

func (connector *ServiceConnector) removeSystemdUnit(ctx context.Context) error {
	_, stopErr := connector.runner.Run(
		ctx,
		"systemctl",
		"--user",
		"stop",
		machineConnectorSystemdUnit,
	)
	if stopErr != nil {
		if commandUnavailable(stopErr) || ctx.Err() != nil {
			return fmt.Errorf("stop machine connector systemd service: %w", stopErr)
		}
		loaded, inspectErr := connector.systemdUnitLoaded(ctx)
		if inspectErr != nil {
			return errors.Join(
				fmt.Errorf("stop machine connector systemd service: %w", stopErr),
				inspectErr,
			)
		}
		if loaded {
			return fmt.Errorf("stop machine connector systemd service: %w", stopErr)
		}
		return nil
	}

	_, resetErr := connector.runner.Run(
		ctx,
		"systemctl",
		"--user",
		"reset-failed",
		machineConnectorSystemdUnit,
	)
	if resetErr == nil {
		return nil
	}
	if commandUnavailable(resetErr) || ctx.Err() != nil {
		return fmt.Errorf("reset machine connector systemd service: %w", resetErr)
	}
	loaded, inspectErr := connector.systemdUnitLoaded(ctx)
	if inspectErr != nil {
		return errors.Join(
			fmt.Errorf("reset machine connector systemd service: %w", resetErr),
			inspectErr,
		)
	}
	if loaded {
		return fmt.Errorf("reset machine connector systemd service: %w", resetErr)
	}
	return nil
}

func (connector *ServiceConnector) systemdUnitLoaded(ctx context.Context) (bool, error) {
	output, err := connector.runner.Run(
		ctx,
		"systemctl",
		"--user",
		"show",
		"--property=LoadState",
		"--value",
		machineConnectorSystemdUnit,
	)
	if err != nil {
		return false, fmt.Errorf("inspect machine connector systemd service: %w", err)
	}
	switch state := strings.TrimSpace(string(output)); state {
	case "not-found":
		return false, nil
	case "loaded", "masked":
		return true, nil
	default:
		return false, fmt.Errorf("inspect machine connector systemd service: unexpected load state %q", state)
	}
}
