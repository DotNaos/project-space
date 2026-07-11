//go:build windows

package machineconnect

import (
	"errors"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	windowsDPAPIEntropyValue = "net.os-home.project-space.machine-credential/v1"
	windowsDPAPIFlags        = windows.CRYPTPROTECT_UI_FORBIDDEN
)

func protectWindowsDPAPI(plaintext []byte) ([]byte, error) {
	if len(plaintext) == 0 || len(plaintext) > maximumLocalMachineStateBytes {
		return nil, errors.New("protect machine credential: invalid plaintext")
	}
	input := windowsDataBlob(plaintext)
	entropyBytes := []byte(windowsDPAPIEntropyValue)
	entropy := windowsDataBlob(entropyBytes)
	var output windows.DataBlob
	protectErr := windows.CryptProtectData(
		&input,
		nil,
		&entropy,
		0,
		nil,
		windowsDPAPIFlags,
		&output,
	)
	runtime.KeepAlive(plaintext)
	runtime.KeepAlive(entropyBytes)
	if protectErr != nil {
		releaseWindowsDataBlob(&output)
		return nil, errors.New("protect machine credential: Windows data protection failed")
	}
	return copyAndReleaseWindowsDataBlob(
		&output,
		maximumWindowsDPAPIEncryptedBytes,
		"protect machine credential: invalid protected value",
	)
}

func unprotectWindowsDPAPI(ciphertext []byte) ([]byte, error) {
	if len(ciphertext) == 0 || len(ciphertext) > maximumWindowsDPAPIEncryptedBytes {
		return nil, errors.New("unprotect machine credential: invalid protected value")
	}
	input := windowsDataBlob(ciphertext)
	entropyBytes := []byte(windowsDPAPIEntropyValue)
	entropy := windowsDataBlob(entropyBytes)
	var output windows.DataBlob
	unprotectErr := windows.CryptUnprotectData(
		&input,
		nil,
		&entropy,
		0,
		nil,
		windowsDPAPIFlags,
		&output,
	)
	runtime.KeepAlive(ciphertext)
	runtime.KeepAlive(entropyBytes)
	if unprotectErr != nil {
		releaseWindowsDataBlob(&output)
		return nil, errors.New("unprotect machine credential: protected value is invalid")
	}
	return copyAndReleaseWindowsDataBlob(
		&output,
		maximumLocalMachineStateBytes,
		"unprotect machine credential: invalid plaintext",
	)
}

func windowsDataBlob(value []byte) windows.DataBlob {
	if len(value) == 0 {
		return windows.DataBlob{}
	}
	return windows.DataBlob{Size: uint32(len(value)), Data: &value[0]}
}

func copyAndReleaseWindowsDataBlob(
	blob *windows.DataBlob,
	maximumSize int,
	invalidMessage string,
) (copied []byte, err error) {
	if blob == nil || blob.Data == nil {
		return nil, errors.New(invalidMessage)
	}
	defer func() {
		if freeErr := releaseWindowsDataBlob(blob); freeErr != nil && err == nil {
			clear(copied)
			copied = nil
			err = errors.New("release protected machine credential memory")
		}
	}()
	if blob.Size == 0 || uint64(blob.Size) > uint64(maximumSize) {
		return nil, errors.New(invalidMessage)
	}
	copied = append([]byte(nil), unsafe.Slice(blob.Data, int(blob.Size))...)
	return copied, nil
}

func releaseWindowsDataBlob(blob *windows.DataBlob) error {
	if blob == nil || blob.Data == nil {
		return nil
	}
	_, err := windows.LocalFree(windows.Handle(unsafe.Pointer(blob.Data)))
	blob.Data = nil
	blob.Size = 0
	return err
}
