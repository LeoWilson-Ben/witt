package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestProcessManagerStartPollAndKill(t *testing.T) {
	pm := newProcessManager()
	defer pm.CloseAll()

	cwd := t.TempDir()
	// Start a quick ping/echo-like process via PowerShell on Windows or sh on Unix.
	id, err := pm.Start(cwd, "cmd", []string{"/c", "echo hello-witt & echo second-line"}, nil)
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	var combined strings.Builder
	offset := 0
	for i := 0; i < 20; i++ {
		snap, pollErr := pm.Poll(context.Background(), id, offset, 500)
		if pollErr != nil {
			t.Fatalf("Poll failed: %v", pollErr)
		}
		combined.WriteString(snap.Output)
		offset = snap.NextOffset
		if !snap.Running {
			if snap.ExitCode == nil || *snap.ExitCode != 0 {
				t.Fatalf("unexpected exit code: %v", snap.ExitCode)
			}
			break
		}
	}
	if !strings.Contains(combined.String(), "hello-witt") || !strings.Contains(combined.String(), "second-line") {
		t.Fatalf("missing expected output, got %q", combined.String())
	}

	// Start a long-running process and verify Kill stops it cleanly.
	longID, err := pm.Start(cwd, "powershell", []string{"-NoProfile", "-Command", "Write-Output 'started'; Start-Sleep -Seconds 30"}, nil)
	if err != nil {
		t.Fatalf("Start long process failed: %v", err)
	}
	snap, err := pm.Poll(context.Background(), longID, 0, 3000)
	if err != nil {
		t.Fatalf("Poll long process failed: %v", err)
	}
	if !snap.Running && snap.Output == "" {
		t.Fatalf("expected long process running or output, got %+v", snap)
	}
	if err := pm.Kill(longID); err != nil {
		t.Fatalf("Kill failed: %v", err)
	}
	after, err := pm.Poll(context.Background(), longID, 0, 0)
	if err != nil {
		t.Fatalf("Poll after kill failed: %v", err)
	}
	if after.Running {
		t.Fatalf("expected process stopped after Kill")
	}
}

func TestWorkspaceExecStartPollKillSchemaAndDispatch(t *testing.T) {
	pm := newProcessManager()
	defer pm.CloseAll()

	cwd := t.TempDir()
	cfg := agentConfig{
		roots:      map[string]string{"project": cwd},
		fullAccess: true,
		processes:  pm,
	}

	startArgs, _ := json.Marshal(map[string]any{
		"operation": "workspace.exec_start",
		"root":      "project",
		"program":   "cmd",
		"argv":      []string{"/c", "echo schema-ok"},
	})
	startRes := executeWithConfig(context.Background(), packet{
		V: 1, Type: "command", ID: "cmd-1", Tool: "workspace", Args: startArgs, TimeoutMS: 5000,
	}, "dev-1", cfg)
	if startRes.Error != "" || startRes.ExitCode != 0 {
		t.Fatalf("exec_start failed: %+v", startRes)
	}
	var started struct {
		ProcessID string `json:"process_id"`
		Running   bool   `json:"running"`
	}
	if err := json.Unmarshal([]byte(startRes.Stdout), &started); err != nil || started.ProcessID == "" {
		t.Fatalf("invalid exec_start stdout %q: %v", startRes.Stdout, err)
	}

	deadline := time.Now().Add(5 * time.Second)
	var output strings.Builder
	offset := 0
	for time.Now().Before(deadline) {
		pollArgs, _ := json.Marshal(map[string]any{
			"operation":  "workspace.exec_poll",
			"root":       "project",
			"process_id": started.ProcessID,
			"offset":     offset,
			"wait_ms":    500,
		})
		pollRes := executeWithConfig(context.Background(), packet{
			V: 1, Type: "command", ID: "cmd-2", Tool: "workspace", Args: pollArgs, TimeoutMS: 5000,
		}, "dev-1", cfg)
		if pollRes.Error != "" || pollRes.ExitCode != 0 {
			t.Fatalf("exec_poll failed: %+v", pollRes)
		}
		var snap processSnapshot
		if err := json.Unmarshal([]byte(pollRes.Stdout), &snap); err != nil {
			t.Fatalf("invalid poll json: %v", err)
		}
		output.WriteString(snap.Output)
		offset = snap.NextOffset
		if !snap.Running {
			break
		}
	}
	if !strings.Contains(output.String(), "schema-ok") {
		t.Fatalf("expected schema-ok in output, got %q", output.String())
	}
}
