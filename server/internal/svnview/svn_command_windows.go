//go:build windows

package svnview

import (
	"os/exec"
	"syscall"
)

func configureSVNCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windowsSVNCreationFlags(),
	}
}
