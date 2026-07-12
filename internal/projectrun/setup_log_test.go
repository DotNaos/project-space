package projectrun

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupLogIsBoundedPrivateSanitizedAndRedacted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "setup.log")
	log, err := openBoundedSetupLog(path)
	if err != nil {
		t.Fatal(err)
	}
	noise := strings.Repeat("x", int(runtimeLogLimit)+1024)
	secret := "\n\x1b[31mNPM_TOKEN=top-secret-value\x1b[0m\n" +
		"Authorization: Bearer header-secret\n" +
		`{"password":"json-secret","url":"https://user:url-secret@example.com"}` + "\n" +
		"npm_abcdefghijklmnopqrstuvwxyz123456\n" +
		"github_pat_abcdefghijklmnopqrstuvwxyz123456\n" +
		"-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----"
	if _, err := log.Write([]byte(noise + secret)); err != nil {
		t.Fatal(err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 || info.Size() > runtimeLogLimit {
		t.Fatalf("setup log mode=%o size=%d", info.Mode().Perm(), info.Size())
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	output := string(body)
	for _, forbidden := range []string{"top-secret-value", "header-secret", "json-secret", "url-secret", "npm_abcdefghijklmnopqrstuvwxyz123456", "github_pat_abcdefghijklmnopqrstuvwxyz123456", "private-key-material", "\x1b"} {
		if strings.Contains(output, forbidden) {
			t.Fatalf("setup log leaked %q: %q", forbidden, output)
		}
	}
	if !strings.Contains(output, "[REDACTED]") {
		t.Fatalf("setup log did not retain redaction marker: %q", output)
	}
}

func TestSetupStreamsNeverExposeRawChildOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "setup.log")
	log, err := openBoundedSetupLog(path)
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	streams := setupStreams(Streams{Stdout: stdout, Stderr: stderr}, log)
	secret := "Authorization: Bearer never-print-this"
	if _, err := streams.Stdout.Write([]byte(secret)); err != nil {
		t.Fatal(err)
	}
	if _, err := streams.Stderr.Write([]byte("\nTOKEN=also-never-print-this")); err != nil {
		t.Fatal(err)
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("raw setup output reached caller: stdout=%q stderr=%q", stdout, stderr)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"never-print-this", "also-never-print-this"} {
		if bytes.Contains(body, []byte(forbidden)) {
			t.Fatalf("persisted setup log leaked %q: %q", forbidden, body)
		}
	}
}
