package gadgets

// The only Gizmo in the workspace. Rotor shares the method name, so a Spin()
// call resolves only once its receiver is typed.
type Gizmo struct {
	Turns int
}

func (g *Gizmo) Spin() int {
	return g.Turns
}

type Rotor struct {
	Blades int
}

func (r *Rotor) Spin() int {
	return r.Blades
}
