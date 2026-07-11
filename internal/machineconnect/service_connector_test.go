package machineconnect

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type serviceCommandCall struct {
	name      string
	arguments []string
}

type serviceCommandResponse struct {
	output string
	err    error
}

type scriptedServiceRunner struct {
	calls     []serviceCommandCall
	responses []serviceCommandResponse
}

func (runner *scriptedServiceRunner) Run(
	_ context.Context,
	name string,
	arguments ...string,
) ([]byte, error) {
	runner.calls = append(runner.calls, serviceCommandCall{
		name:      name,
		arguments: append([]string(nil), arguments...),
	})
	if len(runner.responses) == 0 {
		return nil, errors.New("unexpected service command")
	}
	response := runner.responses[0]
	runner.responses = runner.responses[1:]
	return []byte(response.output), response.err
}

type recordingServiceFiles struct {
	directories []string
	files       map[string][]byte
	removed     []string
}

func (files *recordingServiceFiles) EnsurePrivateDirectory(path string) error {
	files.directories = append(files.directories, path)
	return nil
}

func (files *recordingServiceFiles) WritePrivateFile(path string, content []byte) error {
	if files.files == nil {
		files.files = map[string][]byte{}
	}
	files.files[path] = append([]byte(nil), content...)
	return nil
}

func (files *recordingServiceFiles) RemoveFile(path string) error {
	files.removed = append(files.removed, path)
	delete(files.files, path)
	return nil
}

func TestSystemdServiceConnectorStartsHardenedTransientUserUnit(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "not-found\n"},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
	}, runner, &recordingServiceFiles{})

	if err := connector.Start(context.Background()); err != nil {
		t.Fatalf("start service connector: %v", err)
	}
	if len(runner.calls) != 2 || runner.calls[1].name != "systemd-run" {
		t.Fatalf("service calls = %#v", runner.calls)
	}
	arguments := runner.calls[1].arguments
	for _, required := range []string{
		"--user",
		"--unit=" + machineConnectorSystemdUnit,
		"--collect",
		"--property=Type=exec",
		"--property=Restart=on-failure",
		"--property=RestartSec=5s",
		"--property=UMask=0077",
		"--property=NoNewPrivileges=true",
		"--property=PrivateTmp=true",
	} {
		if !containsArgument(arguments, required) {
			t.Errorf("systemd-run arguments lack %q: %#v", required, arguments)
		}
	}
	joined := strings.Join(arguments, " ")
	for _, forbidden := range []string{"PrivateDevices", "credential", "token", "PROJECT_"} {
		if strings.Contains(strings.ToLower(joined), strings.ToLower(forbidden)) {
			t.Errorf("systemd-run arguments contain forbidden value %q: %s", forbidden, joined)
		}
	}
	wantTail := []string{"--", "/opt/project/bin/project", "connector", "run"}
	if !reflect.DeepEqual(arguments[len(arguments)-len(wantTail):], wantTail) {
		t.Fatalf("systemd-run command tail = %#v, want %#v", arguments, wantTail)
	}
	if machineConnectorSystemdUnit == "project-space-connector.service" {
		t.Fatal("machine connector reused the existing production systemd unit")
	}
}

func TestSystemdServiceConnectorRestartsActiveUnitToReloadCredential(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "loaded\n"},
		{},
		{},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
	}, runner, &recordingServiceFiles{})

	if err := connector.Start(context.Background()); err != nil {
		t.Fatalf("start active service connector: %v", err)
	}
	wantNames := []string{"systemctl", "systemctl", "systemctl", "systemd-run"}
	if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(got, wantNames) {
		t.Fatalf("active service calls = %#v, want %#v", runner.calls, wantNames)
	}
}

func TestSystemdServiceConnectorReplacesInactiveUnit(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "loaded\n"},
		{},
		{},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
	}, runner, &recordingServiceFiles{})

	if err := connector.Start(context.Background()); err != nil {
		t.Fatalf("replace inactive service connector: %v", err)
	}
	wantNames := []string{"systemctl", "systemctl", "systemctl", "systemd-run"}
	if !reflect.DeepEqual(serviceCommandNames(runner.calls), wantNames) {
		t.Fatalf("service command names = %#v, want %#v", serviceCommandNames(runner.calls), wantNames)
	}
}

func TestSystemdServiceConnectorAcceptsConcurrentIdempotentStart(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{output: "not-found\n"},
		{err: errors.New("unit already exists")},
		{},
	}}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/opt/project/bin/project",
		GOOS:       "linux",
	}, runner, &recordingServiceFiles{})

	if err := connector.Start(context.Background()); err != nil {
		t.Fatalf("concurrent idempotent start: %v", err)
	}
	if len(runner.calls) != 3 || !containsArgument(runner.calls[2].arguments, "is-active") {
		t.Fatalf("concurrent start calls = %#v", runner.calls)
	}
}

func TestSystemdServiceConnectorStopIsIdempotent(t *testing.T) {
	t.Run("absent", func(t *testing.T) {
		runner := &scriptedServiceRunner{responses: []serviceCommandResponse{{output: "not-found\n"}}}
		connector := testServiceConnector(t, ServiceConnectorOptions{
			Executable: "/opt/project/bin/project",
			GOOS:       "linux",
		}, runner, &recordingServiceFiles{})
		if err := connector.Stop(context.Background()); err != nil {
			t.Fatalf("stop absent service connector: %v", err)
		}
		if len(runner.calls) != 1 {
			t.Fatalf("absent stop calls = %#v", runner.calls)
		}
	})

	t.Run("loaded", func(t *testing.T) {
		runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
			{output: "loaded\n"},
			{},
			{},
		}}
		connector := testServiceConnector(t, ServiceConnectorOptions{
			Executable: "/opt/project/bin/project",
			GOOS:       "linux",
		}, runner, &recordingServiceFiles{})
		if err := connector.Stop(context.Background()); err != nil {
			t.Fatalf("stop loaded service connector: %v", err)
		}
		if got := serviceCommandNames(runner.calls); !reflect.DeepEqual(
			got,
			[]string{"systemctl", "systemctl", "systemctl"},
		) {
			t.Fatalf("loaded stop commands = %#v", got)
		}
	})
}

func TestLaunchdServiceConnectorWritesPrivateCredentialFreeAgent(t *testing.T) {
	runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
		{err: errors.New("service absent")},
		{output: "Could not find service", err: errors.New("service absent")},
		{},
		{},
	}}
	files := &recordingServiceFiles{}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: "/Applications/Project & Space/project",
		GOOS:       "darwin",
		HomeDir:    "/Users/project & space",
		UserID:     "501",
	}, runner, files)

	if err := connector.Start(context.Background()); err != nil {
		t.Fatalf("start LaunchAgent: %v", err)
	}
	paths := connector.launchdPaths()
	if !reflect.DeepEqual(files.directories, []string{filepath.Dir(paths.plist), paths.logDir}) {
		t.Fatalf("private directories = %#v", files.directories)
	}
	plist := string(files.files[paths.plist])
	for _, required := range []string{
		"<string>" + machineConnectorLaunchLabel + "</string>",
		"<string>/Applications/Project &amp; Space/project</string>",
		"<string>connector</string>",
		"<string>run</string>",
		"<key>SuccessfulExit</key>",
		"<key>ThrottleInterval</key>",
		"<key>Umask</key>",
		"<integer>63</integer>",
	} {
		if !strings.Contains(plist, required) {
			t.Errorf("LaunchAgent plist lacks %q:\n%s", required, plist)
		}
	}
	for _, forbidden := range []string{
		"EnvironmentVariables",
		"PROJECT_CONNECTOR_REGISTRATION_TOKEN",
		"PROJECT_SPACE_CONNECTOR_RUNTIME_PROTOCOL",
		"machineId",
		"credential",
	} {
		if strings.Contains(plist, forbidden) {
			t.Errorf("LaunchAgent plist contains forbidden value %q", forbidden)
		}
	}
	if machineConnectorLaunchLabel == "net.os-home.project-space-connector" {
		t.Fatal("machine connector reused the existing production LaunchAgent label")
	}
	wantNames := []string{"launchctl", "launchctl", "launchctl", "launchctl"}
	if !reflect.DeepEqual(serviceCommandNames(runner.calls), wantNames) {
		t.Fatalf("LaunchAgent commands = %#v", runner.calls)
	}
	if !reflect.DeepEqual(runner.calls[0].arguments, []string{
		"bootout",
		"gui/501/" + machineConnectorLaunchLabel,
	}) || !reflect.DeepEqual(runner.calls[2].arguments, []string{
		"bootstrap",
		"gui/501",
		paths.plist,
	}) || !reflect.DeepEqual(runner.calls[3].arguments, []string{
		"kickstart",
		"-k",
		"gui/501/" + machineConnectorLaunchLabel,
	}) {
		t.Fatalf("LaunchAgent command arguments = %#v", runner.calls)
	}
}

func TestLaunchdServiceConnectorStartAndStopAreIdempotent(t *testing.T) {
	t.Run("start replaces loaded service", func(t *testing.T) {
		runner := &scriptedServiceRunner{responses: []serviceCommandResponse{{}, {}, {}}}
		connector := testServiceConnector(t, ServiceConnectorOptions{
			Executable: "/usr/local/bin/project",
			GOOS:       "darwin",
			HomeDir:    "/Users/test",
			UserID:     "502",
		}, runner, &recordingServiceFiles{})
		if err := connector.Start(context.Background()); err != nil {
			t.Fatalf("replace LaunchAgent: %v", err)
		}
		if got := runner.calls; len(got) != 3 || got[0].arguments[0] != "bootout" ||
			got[1].arguments[0] != "bootstrap" || got[2].arguments[0] != "kickstart" {
			t.Fatalf("LaunchAgent replacement calls = %#v", got)
		}
	})

	t.Run("stop absent service", func(t *testing.T) {
		runner := &scriptedServiceRunner{responses: []serviceCommandResponse{
			{err: errors.New("service absent")},
			{output: "Could not find service", err: errors.New("service absent")},
		}}
		files := &recordingServiceFiles{}
		connector := testServiceConnector(t, ServiceConnectorOptions{
			Executable: "/usr/local/bin/project",
			GOOS:       "darwin",
			HomeDir:    "/Users/test",
			UserID:     "502",
		}, runner, files)
		if err := connector.Stop(context.Background()); err != nil {
			t.Fatalf("stop absent LaunchAgent: %v", err)
		}
		if len(runner.calls) != 2 || runner.calls[0].arguments[0] != "bootout" ||
			runner.calls[1].arguments[0] != "print" {
			t.Fatalf("absent LaunchAgent stop calls = %#v", runner.calls)
		}
		if !reflect.DeepEqual(files.removed, []string{connector.launchdPaths().plist}) {
			t.Fatalf("removed LaunchAgent files = %#v", files.removed)
		}
	})
}

func TestNativeWindowsServiceConnectorReturnsWSLGuidance(t *testing.T) {
	runner := &scriptedServiceRunner{}
	connector := testServiceConnector(t, ServiceConnectorOptions{
		Executable: `C:\Program Files\Project\project.exe`,
		GOOS:       "windows",
	}, runner, &recordingServiceFiles{})
	for _, operation := range []struct {
		name string
		run  func(context.Context) error
	}{{"start", connector.Start}, {"stop", connector.Stop}} {
		err := operation.run(context.Background())
		if !errors.Is(err, ErrNativeWindowsServiceUnsupported) || !strings.Contains(err.Error(), "WSL") {
			t.Fatalf("%s native Windows error = %v", operation.name, err)
		}
	}
	if len(runner.calls) != 0 {
		t.Fatalf("native Windows invoked service manager: %#v", runner.calls)
	}
}

func TestServiceConnectorDoesNotHideMissingServiceManagers(t *testing.T) {
	for name, options := range map[string]ServiceConnectorOptions{
		"linux": {
			Executable: "/usr/local/bin/project",
			GOOS:       "linux",
		},
		"darwin": {
			Executable: "/usr/local/bin/project",
			GOOS:       "darwin",
			HomeDir:    "/Users/test",
			UserID:     "501",
		},
	} {
		t.Run(name, func(t *testing.T) {
			runner := &scriptedServiceRunner{responses: []serviceCommandResponse{{
				err: missingServiceCommand(map[string]string{
					"linux":  "systemctl",
					"darwin": "launchctl",
				}[name]),
			}}}
			connector := testServiceConnector(
				t,
				options,
				runner,
				&recordingServiceFiles{},
			)
			if err := connector.Start(context.Background()); err == nil {
				t.Fatal("expected missing service manager error")
			}
		})
	}
}

func TestOSServiceFileSystemUsesPrivateAtomicFiles(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "LaunchAgents")
	files := osServiceFileSystem{}
	if err := files.EnsurePrivateDirectory(directory); err != nil {
		t.Fatalf("prepare private directory: %v", err)
	}
	info, err := os.Stat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("private directory mode = %o, want 700", info.Mode().Perm())
	}

	target := filepath.Join(root, "existing-target")
	if err := os.WriteFile(target, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	plist := filepath.Join(directory, "machine.plist")
	if err := os.Symlink(target, plist); err != nil {
		t.Fatal(err)
	}
	if err := files.WritePrivateFile(plist, []byte("private plist")); err != nil {
		t.Fatalf("atomically replace private file: %v", err)
	}
	content, err := os.ReadFile(plist)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "private plist" {
		t.Fatalf("private file content = %q", content)
	}
	info, err = os.Lstat(plist)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("private file mode = %v", info.Mode())
	}
	targetContent, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(targetContent) != "unchanged" {
		t.Fatalf("symlink target was overwritten: %q", targetContent)
	}
	matches, err := filepath.Glob(filepath.Join(directory, ".machine-connector-*.tmp"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("temporary files after atomic write = %#v, err=%v", matches, err)
	}
}

func TestServiceConnectorRejectsInvalidPlatformInputs(t *testing.T) {
	for name, options := range map[string]ServiceConnectorOptions{
		"padded operating system": {
			Executable: "/usr/local/bin/project",
			GOOS:       " linux ",
		},
		"relative macOS home": {
			Executable: "/usr/local/bin/project",
			GOOS:       "darwin",
			HomeDir:    "Users/test",
			UserID:     "501",
		},
		"non-numeric macOS user": {
			Executable: "/usr/local/bin/project",
			GOOS:       "darwin",
			HomeDir:    "/Users/test",
			UserID:     "user",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := newServiceConnector(
				options,
				&scriptedServiceRunner{},
				&recordingServiceFiles{},
			); err == nil {
				t.Fatal("expected invalid input error")
			}
		})
	}
}

func testServiceConnector(
	t *testing.T,
	options ServiceConnectorOptions,
	runner serviceCommandRunner,
	files serviceFileSystem,
) *ServiceConnector {
	t.Helper()
	connector, err := newServiceConnector(options, runner, files)
	if err != nil {
		t.Fatalf("create service connector: %v", err)
	}
	return connector
}

func containsArgument(arguments []string, wanted string) bool {
	for _, argument := range arguments {
		if argument == wanted {
			return true
		}
	}
	return false
}

func serviceCommandNames(calls []serviceCommandCall) []string {
	names := make([]string, 0, len(calls))
	for _, call := range calls {
		names = append(names, call.name)
	}
	return names
}

func missingServiceCommand(name string) error {
	return &exec.Error{Name: name, Err: exec.ErrNotFound}
}
