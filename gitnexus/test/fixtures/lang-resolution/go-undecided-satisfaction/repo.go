package undecided

// A DOT import contributes no qualifier — Go puts the imported names straight
// into this file's scope, so `shapes.Point` names a package the analyzer has no
// identity for. The satisfaction check below cannot be performed at all.
import . "example.com/vendor/shapes"

type Drawer interface {
	Draw(p shapes.Point) error
}

type Canvas struct{}

func (c *Canvas) Draw(p shapes.Point) error { return nil }

// Control: decided in the same file, so the record must name Drawer only.
type Named interface {
	Name() string
}

type Label struct{}

func (l *Label) Name() string { return "" }
