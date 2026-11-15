package clock

// Clock exists only in the root module, so its import resolves no matter how
// the module root is anchored: the control for the root module's own imports.
type Clock struct{}

func (c *Clock) Tick() {}
