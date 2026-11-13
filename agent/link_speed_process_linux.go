//go:build linux

package main

import (
	"os/exec"
	"syscall"
)

func configureSpeedProcess(cmd *exec.Cmd) {
	// Temporary listeners must not survive an abrupt Agent exit.
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
