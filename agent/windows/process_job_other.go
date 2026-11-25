//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

type processJob struct {
	pid int
}

func configureCmdSysProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func attachProcessJob(proc *os.Process) *processJob {
	if proc == nil {
		return nil
	}
	return &processJob{pid: proc.Pid}
}

func (j *processJob) Kill() {
	if j == nil || j.pid <= 0 {
		return
	}
	_ = syscall.Kill(-j.pid, syscall.SIGKILL)
	j.pid = 0
}
