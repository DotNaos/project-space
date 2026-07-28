package terminallauncher

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDarwinUsesResolvedDefaultTerminalWithDirectoryOnly(t *testing.T) {
	directory := t.TempDir()
	var started Process
	launcher := newPlatformLauncher("darwin", Dependencies{
		LookPath: func(name string) (string, error) {
			if name != "open" {
				t.Fatalf("lookup = %q", name)
			}
			return "/usr/bin/open", nil
		},
		ResolveDarwinDefault: func(context.Context) (Application, error) {
			return Application{BundleID: "com.example.Terminal", Name: "Selected Terminal"}, nil
		},
		Start: func(process Process) error {
			started = process
			return nil
		},
		Stat: os.Stat,
	})

	result, err := launcher.Open(context.Background(), directory)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if result.Launcher != "Selected Terminal" || result.Selection != SelectionSystemDefault {
		t.Fatalf("result = %#v", result)
	}
	if started.Name != "/usr/bin/open" ||
		len(started.Args) != 4 ||
		started.Args[0] != "-b" ||
		started.Args[1] != "com.example.Terminal" ||
		started.Args[2] != "--" ||
		started.Args[3] != directory ||
		started.Dir != "" ||
		started.NewConsole {
		t.Fatalf("process = %#v", started)
	}
}

func TestWindowsLetsTheSelectedConsoleHostOpenCmdAtTheDirectory(t *testing.T) {
	directory := t.TempDir()
	var started Process
	launcher := newPlatformLauncher("windows", Dependencies{
		LookPath: func(name string) (string, error) {
			if name != "cmd.exe" {
				t.Fatalf("lookup = %q", name)
			}
			return `C:\Windows\System32\cmd.exe`, nil
		},
		Start: func(process Process) error {
			started = process
			return nil
		},
		Stat: os.Stat,
	})

	result, err := launcher.Open(context.Background(), directory)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if result.Selection != SelectionSystemDefault {
		t.Fatalf("result = %#v", result)
	}
	if started.Dir != directory || !started.NewConsole ||
		len(started.Args) != 2 || started.Args[0] != "/d" || started.Args[1] != "/k" {
		t.Fatalf("process = %#v", started)
	}
}

func TestLinuxUsesDefaultUtilityThenDocumentedFallback(t *testing.T) {
	directory := t.TempDir()
	for _, test := range []struct {
		found     string
		launcher  string
		selection Selection
	}{
		{found: "xdg-terminal-exec", launcher: "xdg-terminal-exec", selection: SelectionSystemDefault},
		{found: "x-terminal-emulator", launcher: "x-terminal-emulator", selection: SelectionFallback},
	} {
		var started Process
		launcher := newPlatformLauncher("linux", Dependencies{
			Getenv: func(name string) string {
				if name == "DISPLAY" {
					return ":0"
				}
				return ""
			},
			LookPath: func(name string) (string, error) {
				if name == test.found {
					return "/usr/bin/" + name, nil
				}
				return "", errors.New("missing")
			},
			Start: func(process Process) error {
				started = process
				return nil
			},
			Stat: os.Stat,
		})

		result, err := launcher.Open(context.Background(), directory)
		if err != nil {
			t.Fatalf("%s open: %v", test.found, err)
		}
		if result.Launcher != test.launcher || result.Selection != test.selection {
			t.Fatalf("%s result = %#v", test.found, result)
		}
		if started.Dir != directory || len(started.Args) != 0 {
			t.Fatalf("%s process = %#v", test.found, started)
		}
	}
}

func TestLauncherRejectsHeadlessUnsupportedAndInvalidPaths(t *testing.T) {
	directory := t.TempDir()
	headless := newPlatformLauncher("linux", Dependencies{
		Getenv:   func(string) string { return "" },
		LookPath: func(string) (string, error) { return "", errors.New("missing") },
		Start:    func(Process) error { t.Fatal("must not start"); return nil },
		Stat:     os.Stat,
	})
	if _, err := headless.Open(context.Background(), directory); !errors.Is(err, ErrHeadless) {
		t.Fatalf("headless error = %v", err)
	}

	unsupported := newPlatformLauncher("plan9", Dependencies{
		Start: func(Process) error { t.Fatal("must not start"); return nil },
		Stat:  os.Stat,
	})
	if _, err := unsupported.Open(context.Background(), directory); !errors.Is(
		err,
		ErrUnsupported,
	) {
		t.Fatalf("unsupported error = %v", err)
	}

	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := headless.Open(context.Background(), file); !errors.Is(err, ErrInvalidDirectory) {
		t.Fatalf("file error = %v", err)
	}
}
