//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

const (
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose        = 0x00002000
	processSetQuota                     = 0x0100
	processTerminate                    = 0x0001
)

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobObjectExtendedLimitInfo struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

var (
	pmKernel32               = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW     = pmKernel32.NewProc("CreateJobObjectW")
	procSetInfoJobObject     = pmKernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJob   = pmKernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject   = pmKernel32.NewProc("TerminateJobObject")
	procOpenProcess          = pmKernel32.NewProc("OpenProcess")
	procCloseHandle          = pmKernel32.NewProc("CloseHandle")
)

type processJob struct {
	handle uintptr
}

func configureCmdSysProcAttr(cmd *exec.Cmd) {
	// Use SW_HIDE instead of CREATE_NO_WINDOW so console subsystems (e.g. powershell.exe)
	// initialize cleanly even when the parent CLI has redirected stdio.
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func attachProcessJob(proc *os.Process) *processJob {
	if proc == nil {
		return nil
	}
	job, _, _ := procCreateJobObjectW.Call(0, 0)
	if job == 0 {
		return nil
	}
	var info jobObjectExtendedLimitInfo
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	ok, _, _ := procSetInfoJobObject.Call(
		job,
		uintptr(jobObjectExtendedLimitInformation),
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if ok == 0 {
		procCloseHandle.Call(job)
		return nil
	}
	pHandle, _, _ := procOpenProcess.Call(uintptr(processSetQuota|processTerminate), 0, uintptr(proc.Pid))
	if pHandle == 0 {
		procCloseHandle.Call(job)
		return nil
	}
	defer procCloseHandle.Call(pHandle)
	assigned, _, _ := procAssignProcessToJob.Call(job, pHandle)
	if assigned == 0 {
		procCloseHandle.Call(job)
		return nil
	}
	return &processJob{handle: job}
}

func (j *processJob) Kill() {
	if j == nil || j.handle == 0 {
		return
	}
	procTerminateJobObject.Call(j.handle, 1)
	procCloseHandle.Call(j.handle)
	j.handle = 0
}
