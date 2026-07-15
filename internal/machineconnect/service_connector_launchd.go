package machineconnect

import (
	"context"
	"errors"
	"fmt"
	"html"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type launchdConnectorPaths struct {
	plist     string
	logDir    string
	stdoutLog string
	stderrLog string
}

func (connector *ServiceConnector) startLaunchd(ctx context.Context) error {
	paths := connector.launchdPaths()
	for _, directory := range []string{filepath.Dir(paths.plist), paths.logDir} {
		if err := connector.files.EnsurePrivateDirectory(directory); err != nil {
			return fmt.Errorf("prepare private connector LaunchAgent directory: %w", err)
		}
	}
	domain := "gui/" + connector.userID
	service := domain + "/" + machineConnectorLaunchLabel
	_, bootoutErr := connector.runner.Run(ctx, "launchctl", "bootout", service)
	if bootoutErr != nil {
		if commandUnavailable(bootoutErr) || ctx.Err() != nil {
			return fmt.Errorf("unload connector LaunchAgent: %w", bootoutErr)
		}
		// bootout reports an error when the service is already absent. If it is
		// still present, the error is real and must not be hidden.
		printOutput, printErr := connector.runner.Run(ctx, "launchctl", "print", service)
		if printErr == nil {
			return fmt.Errorf("unload connector LaunchAgent: %w", bootoutErr)
		} else if commandUnavailable(printErr) || ctx.Err() != nil {
			return fmt.Errorf("inspect connector LaunchAgent: %w", printErr)
		} else if !launchdServiceAbsent(printOutput, printErr) {
			return errors.Join(
				fmt.Errorf("unload connector LaunchAgent: %w", bootoutErr),
				fmt.Errorf("inspect connector LaunchAgent: %w", printErr),
			)
		}
	} else if err := connector.waitForLaunchdRemoval(ctx, service); err != nil {
		return err
	}
	if err := connector.files.WritePrivateFile(
		paths.plist,
		connector.launchdPlist(paths),
	); err != nil {
		return fmt.Errorf("write connector LaunchAgent: %w", err)
	}

	_, bootstrapErr := connector.runner.Run(ctx, "launchctl", "bootstrap", domain, paths.plist)
	if bootstrapErr != nil {
		if commandUnavailable(bootstrapErr) || ctx.Err() != nil {
			return fmt.Errorf("load connector LaunchAgent: %w", bootstrapErr)
		}
		// A concurrent idempotent Start may already have loaded the same label.
		if _, printErr := connector.runner.Run(ctx, "launchctl", "print", service); printErr != nil {
			return errors.Join(
				fmt.Errorf("load connector LaunchAgent: %w", bootstrapErr),
				fmt.Errorf("inspect connector LaunchAgent: %w", printErr),
			)
		}
	}
	// RunAtLoad makes bootstrap start the connector. An immediate kickstart can
	// race that launch and fail even though the new service is healthy.
	return nil
}

func (connector *ServiceConnector) waitForLaunchdRemoval(
	ctx context.Context,
	service string,
) error {
	if connector.launchdRemovalTimeout <= 0 || connector.launchdRemovalPoll <= 0 {
		return errors.New("wait for connector LaunchAgent removal: timing is invalid")
	}
	waitContext, cancel := context.WithTimeout(ctx, connector.launchdRemovalTimeout)
	defer cancel()
	for {
		output, err := connector.runner.Run(waitContext, "launchctl", "print", service)
		if err != nil {
			if waitContext.Err() != nil {
				return fmt.Errorf("wait for connector LaunchAgent removal: %w", waitContext.Err())
			}
			if commandUnavailable(err) {
				return fmt.Errorf("inspect connector LaunchAgent removal: %w", err)
			}
			if launchdServiceAbsent(output, err) {
				return nil
			}
			return fmt.Errorf("inspect connector LaunchAgent removal: %w", err)
		}
		timer := time.NewTimer(connector.launchdRemovalPoll)
		select {
		case <-waitContext.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return fmt.Errorf("wait for connector LaunchAgent removal: %w", waitContext.Err())
		case <-timer.C:
		}
	}
}

func (connector *ServiceConnector) stopLaunchd(ctx context.Context) error {
	service := "gui/" + connector.userID + "/" + machineConnectorLaunchLabel
	_, bootoutErr := connector.runner.Run(ctx, "launchctl", "bootout", service)
	if bootoutErr == nil {
		if err := connector.waitForLaunchdRemoval(ctx, service); err != nil {
			return err
		}
		return connector.removeLaunchdPlist()
	}
	if commandUnavailable(bootoutErr) || ctx.Err() != nil {
		return fmt.Errorf("unload connector LaunchAgent: %w", bootoutErr)
	}
	printOutput, printErr := connector.runner.Run(ctx, "launchctl", "print", service)
	if printErr == nil {
		return fmt.Errorf("unload connector LaunchAgent: %w", bootoutErr)
	} else if commandUnavailable(printErr) || ctx.Err() != nil {
		return fmt.Errorf("inspect connector LaunchAgent: %w", printErr)
	} else if !launchdServiceAbsent(printOutput, printErr) {
		return errors.Join(
			fmt.Errorf("unload connector LaunchAgent: %w", bootoutErr),
			fmt.Errorf("inspect connector LaunchAgent: %w", printErr),
		)
	}
	return connector.removeLaunchdPlist()
}

func launchdServiceAbsent(output []byte, err error) bool {
	message := strings.ToLower(string(output))
	if strings.Contains(message, "could not find service") ||
		strings.Contains(message, "service not found") {
		return true
	}
	var exitError *exec.ExitError
	return errors.As(err, &exitError) && exitError.ExitCode() == 113
}

func (connector *ServiceConnector) removeLaunchdPlist() error {
	if err := connector.files.RemoveFile(connector.launchdPaths().plist); err != nil {
		return fmt.Errorf("remove connector LaunchAgent: %w", err)
	}
	return nil
}

func (connector *ServiceConnector) launchdPaths() launchdConnectorPaths {
	logDir := filepath.Join(
		connector.homeDir,
		"Library",
		"Logs",
		"Project Space",
		"Machine Connector Supervisor",
	)
	return launchdConnectorPaths{
		plist: filepath.Join(
			connector.homeDir,
			"Library",
			"LaunchAgents",
			machineConnectorLaunchLabel+".plist",
		),
		logDir:    logDir,
		stdoutLog: filepath.Join(logDir, "stdout.log"),
		stderrLog: filepath.Join(logDir, "stderr.log"),
	}
}

func (connector *ServiceConnector) launchdPlist(paths launchdConnectorPaths) []byte {
	escape := html.EscapeString
	return []byte(fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>connector</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>%s</string>
  <key>StandardErrorPath</key>
  <string>%s</string>
</dict>
</plist>
`,
		escape(machineConnectorLaunchLabel),
		escape(connector.executable),
		escape(paths.stdoutLog),
		escape(paths.stderrLog),
	))
}
