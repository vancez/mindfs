package svnview

import (
	"context"
	"os/exec"
)

func newSVNCommand(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "svn", args...)
	configureSVNCommand(cmd)
	return cmd
}

const (
	windowsSVNCreateNewProcessGroup  = uint32(0x00000200)
	windowsSVNCreateDefaultErrorMode = uint32(0x04000000)
	windowsSVNCreateNoWindow         = uint32(0x08000000)
)

func windowsSVNCreationFlags() uint32 {
	return windowsSVNCreateNewProcessGroup | windowsSVNCreateDefaultErrorMode | windowsSVNCreateNoWindow
}
