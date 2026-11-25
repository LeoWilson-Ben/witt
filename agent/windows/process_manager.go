package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"
)

const (
	maxConcurrentProcesses = 8
	maxRetainedProcesses   = 32
	processRingBytes       = 512 * 1024
)

type ringBuffer struct {
	buf   []byte
	start int // earliest byte offset still stored in buf
	total int // total bytes ever written
}

func newRingBuffer(capacity int) *ringBuffer {
	return &ringBuffer{buf: make([]byte, 0, minInt(capacity, 4096))}
}

func (r *ringBuffer) Write(p []byte) {
	if len(p) == 0 {
		return
	}
	r.total += len(p)
	if len(p) >= processRingBytes {
		r.buf = append(r.buf[:0], p[len(p)-processRingBytes:]...)
		r.start = r.total - len(r.buf)
		return
	}
	if len(r.buf)+len(p) > processRingBytes {
		drop := len(r.buf) + len(p) - processRingBytes
		r.buf = append(r.buf[:0], r.buf[drop:]...)
		r.start += drop
	}
	r.buf = append(r.buf, p...)
}

func (r *ringBuffer) ReadFrom(offset int) (data string, nextOffset int, total int, truncated bool) {
	total = r.total
	if offset < r.start {
		truncated = true
		offset = r.start
	}
	if offset > r.total {
		offset = r.total
	}
	rel := offset - r.start
	if rel < len(r.buf) {
		data = string(r.buf[rel:])
	}
	return data, r.total, r.total, truncated
}

type managedProcess struct {
	id       string
	program  string
	argv     []string
	cwd      string
	cmd      *exec.Cmd
	job      *processJob
	mu       sync.Mutex
	ring     *ringBuffer
	running  bool
	exitCode int
	done     chan struct{}
	notify   chan struct{}
}

type processSnapshot struct {
	ProcessID  string `json:"process_id"`
	Running    bool   `json:"running"`
	ExitCode   *int   `json:"exit_code,omitempty"`
	Output     string `json:"output"`
	NextOffset int    `json:"next_offset"`
	TotalBytes int    `json:"total_bytes"`
	Truncated  bool   `json:"truncated,omitempty"`
}

type processManager struct {
	mu    sync.Mutex
	procs map[string]*managedProcess
	order []string
}

func newProcessManager() *processManager {
	return &processManager{procs: make(map[string]*managedProcess)}
}

func randomProcessID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("p-%d", time.Now().UnixNano())
	}
	return "p-" + hex.EncodeToString(b[:])
}

func (m *processManager) Start(cwd, program string, argv []string, extraEnv map[string]string) (string, error) {
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		return "", errors.New("NOT_A_DIRECTORY")
	}

	m.mu.Lock()
	runningCount := 0
	for _, p := range m.procs {
		p.mu.Lock()
		if p.running {
			runningCount++
		}
		p.mu.Unlock()
	}
	if runningCount >= maxConcurrentProcesses {
		m.mu.Unlock()
		return "", errors.New("PROCESS_LIMIT_REACHED")
	}
	// Reap oldest finished process records if table grows beyond retention cap.
	for len(m.order) >= maxRetainedProcesses {
		evicted := false
		for i, id := range m.order {
			if p := m.procs[id]; p != nil {
				p.mu.Lock()
				isRunning := p.running
				p.mu.Unlock()
				if !isRunning {
					delete(m.procs, id)
					m.order = append(m.order[:i], m.order[i+1:]...)
					evicted = true
					break
				}
			}
		}
		if !evicted {
			break
		}
	}
	m.mu.Unlock()

	cmd := exec.Command(program, argv...)
	cmd.Dir = cwd
	configureCmdSysProcAttr(cmd)
	if len(extraEnv) > 0 {
		env := os.Environ()
		for k, v := range extraEnv {
			env = append(env, k+"="+v)
		}
		cmd.Env = env
	}

	pr, pw, err := os.Pipe()
	if err != nil {
		return "", errors.New("COMMAND_FAILED")
	}
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		_ = pw.Close()
		_ = pr.Close()
		return "", errors.New("COMMAND_FAILED")
	}
	_ = pw.Close()

	job := attachProcessJob(cmd.Process)
	proc := &managedProcess{
		id:      randomProcessID(),
		program: program,
		argv:    append([]string(nil), argv...),
		cwd:     cwd,
		cmd:     cmd,
		job:     job,
		ring:    newRingBuffer(processRingBytes),
		running: true,
		done:    make(chan struct{}),
		notify:  make(chan struct{}, 1),
	}

	m.mu.Lock()
	m.procs[proc.id] = proc
	m.order = append(m.order, proc.id)
	m.mu.Unlock()

	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := pr.Read(buf)
			if n > 0 {
				proc.mu.Lock()
				proc.ring.Write(buf[:n])
				proc.mu.Unlock()
				select {
				case proc.notify <- struct{}{}:
				default:
				}
			}
			if readErr != nil {
				break
			}
		}
		_ = pr.Close()
		waitErr := cmd.Wait()
		code := 0
		if waitErr != nil {
			var exitErr *exec.ExitError
			if errors.As(waitErr, &exitErr) {
				code = exitErr.ExitCode()
			} else {
				code = 1
			}
		}
		proc.mu.Lock()
		proc.running = false
		proc.exitCode = code
		if proc.job != nil {
			proc.job.Kill()
			proc.job = nil
		}
		proc.mu.Unlock()
		close(proc.done)
	}()

	return proc.id, nil
}

func (m *processManager) Poll(ctx context.Context, processID string, offset, waitMS int) (processSnapshot, error) {
	m.mu.Lock()
	proc := m.procs[processID]
	m.mu.Unlock()
	if proc == nil {
		return processSnapshot{}, errors.New("PROCESS_NOT_FOUND")
	}
	if offset < 0 {
		offset = 0
	}
	if waitMS < 0 {
		waitMS = 0
	}
	if waitMS > 10000 {
		waitMS = 10000
	}

	snapshot := func() processSnapshot {
		proc.mu.Lock()
		defer proc.mu.Unlock()
		out, next, total, trunc := proc.ring.ReadFrom(offset)
		res := processSnapshot{
			ProcessID:  proc.id,
			Running:    proc.running,
			Output:     out,
			NextOffset: next,
			TotalBytes: total,
			Truncated:  trunc,
		}
		if !proc.running {
			code := proc.exitCode
			res.ExitCode = &code
		}
		return res
	}

	snap := snapshot()
	if snap.Output != "" || !snap.Running || waitMS == 0 {
		return snap, nil
	}

	timer := time.NewTimer(time.Duration(waitMS) * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return snapshot(), nil
		case <-proc.done:
			return snapshot(), nil
		case <-timer.C:
			return snapshot(), nil
		case <-proc.notify:
			s := snapshot()
			if s.Output != "" || !s.Running {
				return s, nil
			}
		}
	}
}

func (m *processManager) Kill(processID string) error {
	m.mu.Lock()
	proc := m.procs[processID]
	m.mu.Unlock()
	if proc == nil {
		return errors.New("PROCESS_NOT_FOUND")
	}
	proc.mu.Lock()
	job := proc.job
	cmd := proc.cmd
	running := proc.running
	proc.mu.Unlock()

	if running {
		if job != nil {
			job.Kill()
		}
		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		select {
		case <-proc.done:
		case <-time.After(3 * time.Second):
		}
	}
	return nil
}

func (m *processManager) CloseAll() {
	m.mu.Lock()
	all := make([]*managedProcess, 0, len(m.procs))
	for _, p := range m.procs {
		all = append(all, p)
	}
	m.mu.Unlock()

	for _, p := range all {
		_ = m.Kill(p.id)
	}
}
