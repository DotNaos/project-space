//go:build linux

package workspacerun

import "golang.org/x/sys/unix"

func exchangeAt(oldDirectory int, oldName string, newDirectory int, newName string) error {
	return unix.Renameat2(oldDirectory, oldName, newDirectory, newName, unix.RENAME_EXCHANGE)
}
