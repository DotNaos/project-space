//go:build !windows

package projectstorage

import "golang.org/x/sys/unix"

func diskFreeBytes(path string) (int64, error) {
	status := unix.Statfs_t{}
	if err := unix.Statfs(path, &status); err != nil {
		return 0, err
	}
	return int64(status.Bavail) * int64(status.Bsize), nil
}
