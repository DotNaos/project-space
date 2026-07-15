//go:build windows

package main

// Managed native-Windows updates are rejected before switching a release.
// Recreating the supervisor in-process therefore restarts only the unchanged
// current runtime and avoids relying on Task Scheduler to relaunch the task.
func restartConnectorSupervisor(string) error { return nil }
