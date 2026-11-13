//go:build !linux

package main

import "os/exec"

func configureSpeedProcess(cmd *exec.Cmd) {}
