package projectrun

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"sync"
)

var (
	setupANSISequence         = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))`)
	setupCredentialAssignment = regexp.MustCompile(`(?i)(\b[A-Za-z0-9_-]*(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]*"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)`)
	setupBearerCredential     = regexp.MustCompile(`(?i)(\bbearer\s+)[A-Za-z0-9._~+/=-]+`)
	setupGitHubCredential     = regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`)
	setupNPMCredential        = regexp.MustCompile(`\bnpm_[A-Za-z0-9]{20,}\b`)
	setupPrivateKeyBlock      = regexp.MustCompile(`(?s)-----BEGIN [^-\r\n]*PRIVATE KEY-----.*?-----END [^-\r\n]*PRIVATE KEY-----`)
	setupURLUserInfo          = regexp.MustCompile(`(https?://)[^/@\s:]+:[^/@\s]+@`)
)

// boundedSetupLog retains only the final 64 KiB in memory while setup runs.
// It writes a sanitized, redacted snapshot to the private file at close, so a
// child process cannot persist credentials by printing them.
type boundedSetupLog struct {
	mutex sync.Mutex
	file  *os.File
	tail  []byte
}

func openBoundedSetupLog(path string) (*boundedSetupLog, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open setup log: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, fmt.Errorf("protect setup log: %w", err)
	}
	return &boundedSetupLog{file: file, tail: make([]byte, 0, int(runtimeLogLimit))}, nil
}

func (log *boundedSetupLog) Write(body []byte) (int, error) {
	log.mutex.Lock()
	defer log.mutex.Unlock()
	if int64(len(body)) >= runtimeLogLimit {
		log.tail = append(log.tail[:0], body[len(body)-int(runtimeLogLimit):]...)
		return len(body), nil
	}
	overflow := len(log.tail) + len(body) - int(runtimeLogLimit)
	if overflow > 0 {
		copy(log.tail, log.tail[overflow:])
		log.tail = log.tail[:len(log.tail)-overflow]
	}
	log.tail = append(log.tail, body...)
	return len(body), nil
}

func (log *boundedSetupLog) Close() error {
	log.mutex.Lock()
	defer log.mutex.Unlock()
	redacted := redactSetupLog(sanitizeRuntimeLog(setupANSISequence.ReplaceAllString(string(log.tail), "")))
	if _, err := log.file.WriteString(redacted); err != nil {
		_ = log.file.Close()
		return fmt.Errorf("write setup log: %w", err)
	}
	if err := log.file.Sync(); err != nil {
		_ = log.file.Close()
		return fmt.Errorf("sync setup log: %w", err)
	}
	if err := log.file.Close(); err != nil {
		return fmt.Errorf("close setup log: %w", err)
	}
	return nil
}

func setupStreams(_ Streams, log io.Writer) Streams {
	// Setup output is untrusted even though the command declaration is trusted:
	// package managers may print registry credentials or authenticated URLs.
	// Never stream it raw to a caller; only persist the redacted bounded copy.
	return Streams{Stdin: nil, Stdout: log, Stderr: log}
}

func redactSetupLog(value string) string {
	value = setupPrivateKeyBlock.ReplaceAllString(value, `[REDACTED PRIVATE KEY]`)
	value = setupBearerCredential.ReplaceAllString(value, `${1}[REDACTED]`)
	value = setupCredentialAssignment.ReplaceAllString(value, `${1}[REDACTED]`)
	value = setupGitHubCredential.ReplaceAllString(value, `[REDACTED]`)
	value = setupNPMCredential.ReplaceAllString(value, `[REDACTED]`)
	return setupURLUserInfo.ReplaceAllString(value, `${1}[REDACTED]@`)
}
