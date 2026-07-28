package terminallauncher

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
)

const resolveDarwinTerminalScript = `ObjC.import("AppKit");
var environment = $.NSProcessInfo.processInfo.environment;
var path = environment.objectForKey("PROJECT_TERMINAL_PROBE_PATH");
var url = $.NSURL.fileURLWithPath(path);
var applicationURL = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url);
if (!applicationURL) throw new Error("no default application");
var bundle = $.NSBundle.bundleWithURL(applicationURL);
[ObjC.unwrap(bundle.bundleIdentifier),
 ObjC.unwrap(applicationURL.lastPathComponent.stringByDeletingPathExtension)].join("\n");`

func resolveDarwinDefaultTerminal(ctx context.Context) (Application, error) {
	probe, err := os.CreateTemp("", "project-terminal-*.sh")
	if err != nil {
		return Application{}, err
	}
	probePath := probe.Name()
	if closeErr := probe.Close(); closeErr != nil {
		_ = os.Remove(probePath)
		return Application{}, closeErr
	}
	defer os.Remove(probePath)

	command := exec.CommandContext(
		ctx,
		"/usr/bin/osascript",
		"-l",
		"JavaScript",
		"-e",
		resolveDarwinTerminalScript,
	)
	command.Env = append(os.Environ(), "PROJECT_TERMINAL_PROBE_PATH="+probePath)
	output, err := command.Output()
	if err != nil {
		return Application{}, err
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) != 2 || lines[0] == "" || lines[1] == "" {
		return Application{}, errors.New("invalid Launch Services response")
	}
	return Application{BundleID: lines[0], Name: lines[1]}, nil
}
