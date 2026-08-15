//go:build windows

package projectstorage

import "golang.org/x/sys/windows"

func diskFreeBytes(path string) (int64, error) {
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var available, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(pointer, &available, &total, &free); err != nil {
		return 0, err
	}
	return int64(available), nil
}
