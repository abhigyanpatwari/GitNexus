package consumers

// Same-package bases for the bare-name embed forms. These exercise the
// byte-identical simple-base path (bare type_identifier) alongside the newly
// handled bare interface embed.

type Local struct {
	Tag string
}

func (l *Local) Tag2() string {
	return l.Tag
}

type LocalIface interface {
	Local2() string
}

// Bare struct embed `Local` (type_identifier) — the long-supported simple-base
// path, unchanged by this fix. → EXTENDS T → Local.
type T struct {
	Local
}

// Bare interface embed `LocalIface` inside an interface body
// (interface_type → type_elem → type_identifier) — previously DROPPED because
// the synth never walked interface bodies. → IMPLEMENTS RLocal → LocalIface.
type RLocal interface {
	LocalIface
}
