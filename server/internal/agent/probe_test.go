package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestProbeInstallStatusUnprobedAgentHasNoUserFacingError(t *testing.T) {
	dir := t.TempDir()
	command := "mindfs-test-probe-agent"
	if runtime.GOOS == "windows" {
		// Keep an explicit extension so LookPath does not depend on PATHEXT.
		command += ".bat"
	}
	if err := os.WriteFile(filepath.Join(dir, command), []byte(""), 0o755); err != nil {
		t.Fatalf("write fake agent: %v", err)
	}
	t.Setenv("PATH", dir)

	status := probeInstallStatus("test-agent", Definition{Name: "test-agent", Command: command}, time.Now().UTC())
	if !status.Installed {
		t.Fatalf("fake command should be detected as installed: %+v", status)
	}
	if status.Available {
		t.Fatalf("installed agent must not be marked available before probing: %+v", status)
	}
	if status.Error != "" {
		t.Fatalf("unprobed agent should not expose a user-facing error: %q", status.Error)
	}
	if status.ProbeError != "" {
		t.Fatalf("unprobed agent should not expose a probe error: %q", status.ProbeError)
	}
}
