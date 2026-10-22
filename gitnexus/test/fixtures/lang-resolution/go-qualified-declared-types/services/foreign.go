package services

import (
	"example.com/elsewhere/ext"
	"example.com/elsewhere/gadgets"
)

// `ext` is not part of this module, so nothing here can say which workspace
// User this would be.
func ArchiveForeign(u ext.User) bool {
	return u.Archive()
}

// Also outside this module, but the workspace declares exactly one Gizmo.
func SpinGadget(g gadgets.Gizmo) int {
	return g.Spin()
}

// The same two shapes reached through struct fields.
type Workshop struct {
	owner  ext.User
	gadget gadgets.Gizmo
}

func (w *Workshop) ArchiveForeignField() bool {
	return w.owner.Archive()
}

func (w *Workshop) SpinGadgetField() int {
	return w.gadget.Spin()
}
