//go:build !windows

package svnview

import "os/exec"

func configureSVNCommand(cmd *exec.Cmd) {
	_ = cmd
}
