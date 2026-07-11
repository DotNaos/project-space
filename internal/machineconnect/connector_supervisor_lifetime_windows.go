//go:build windows

package machineconnect

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"github.com/gofrs/flock"
	"golang.org/x/sys/windows"
)

type windowsConnectorSupervisorLifetime struct {
	job  windows.Handle
	lock *flock.Flock
}

func newConnectorSupervisorLifetime(store CredentialStore) (connectorSupervisorLifetime, error) {
	lockPath := ""
	if provider, ok := store.(connectorRuntimeLockPathProvider); ok {
		lockPath = provider.connectorRuntimeLockPath()
	} else {
		defaultPath, err := DefaultCredentialPath()
		if err != nil {
			return nil, errors.New("resolve connector runtime lock")
		}
		lockPath = defaultPath + ".runtime.lock"
	}
	runtimeLock, err := newWindowsConnectorRuntimeLock(lockPath)
	if err != nil {
		return nil, err
	}
	locked, err := runtimeLock.TryLock()
	if err != nil {
		_ = runtimeLock.Close()
		return nil, errors.New("lock connector runtime")
	}
	if !locked {
		_ = runtimeLock.Close()
		return nil, ErrConnectorRuntimeAlreadyRunning
	}

	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		_ = runtimeLock.Close()
		return nil, errors.New("create connector process container")
	}
	information := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	information.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
	); err != nil {
		_ = windows.CloseHandle(job)
		_ = runtimeLock.Close()
		return nil, errors.New("configure connector process container")
	}
	return &windowsConnectorSupervisorLifetime{job: job, lock: runtimeLock}, nil
}

func newWindowsConnectorRuntimeLock(lockPath string) (*flock.Flock, error) {
	lockPath = strings.TrimSpace(lockPath)
	if lockPath == "" || strings.ContainsRune(lockPath, '\x00') || !filepath.IsAbs(lockPath) {
		return nil, errors.New("connector runtime lock path is invalid")
	}
	if err := ensureWindowsCredentialDirectory(filepath.Dir(lockPath)); err != nil {
		return nil, err
	}
	if err := rejectWindowsReparsePointIfPresent(lockPath); err != nil {
		return nil, err
	}
	return flock.New(lockPath, flock.SetPermissions(0o600)), nil
}

func (lifetime *windowsConnectorSupervisorLifetime) Attach(process *os.Process) error {
	if lifetime == nil || lifetime.job == 0 || process == nil {
		return errors.New("isolate connector companion: process container is unavailable")
	}
	var assignErr error
	handleErr := process.WithHandle(func(handle uintptr) {
		assignErr = windows.AssignProcessToJobObject(lifetime.job, windows.Handle(handle))
	})
	if handleErr != nil || assignErr != nil {
		return errors.New("isolate connector companion in process container")
	}
	return nil
}

func (lifetime *windowsConnectorSupervisorLifetime) Close() error {
	if lifetime == nil {
		return nil
	}
	var closeErr error
	if lifetime.job != 0 {
		if err := windows.CloseHandle(lifetime.job); err != nil {
			closeErr = errors.Join(closeErr, errors.New("close connector process container"))
		}
		lifetime.job = 0
	}
	if lifetime.lock != nil {
		if err := lifetime.lock.Close(); err != nil {
			closeErr = errors.Join(closeErr, errors.New("release connector runtime lock"))
		}
		lifetime.lock = nil
	}
	return closeErr
}
