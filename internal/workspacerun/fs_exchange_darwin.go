//go:build darwin

package workspacerun

import "golang.org/x/sys/unix"

func exchangeAt(oldDirectory int, oldName string, newDirectory int, newName string) error {
	return unix.RenameatxNp(oldDirectory, oldName, newDirectory, newName, unix.RENAME_SWAP)
}
