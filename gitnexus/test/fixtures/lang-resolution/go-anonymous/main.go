// Issue #26 fixture: Go struct with anonymous (embedded) field.
//
// Anonymous fields are NOT emitted as Property nodes — Go promotion is
// structural, not field-level. Instead, we emit a COMPOSITION edge from
// the outer struct to the embedded type. The embedded type's methods
// are still attached to the embedded type (not duplicated onto the
// outer struct's HAS_METHOD list).
//
// M4 fixture: MultiEmbed has TWO anonymous fields (*Base and *Log).
// Both must produce COMPOSITION edges.
//
// M5 fixture: ValEmbed uses a value-typed (non-pointer) anonymous field
// `Base` (not `*Base`). The COMPOSITION edge must still be emitted and
// the target must be `Base`.
package goanonymous

// Base is a struct with a method. It will be embedded into Derived.
type Base struct {
	ID int
}

func (b *Base) Common() int {
	return b.ID
}

// Derived embeds *Base (pointer, anonymous) and has its own field.
type Derived struct {
	*Base
	Name string
}

// OwnMethod is on Derived, not Base.
func (d *Derived) OwnMethod() string {
	return d.Name
}

// ---------------------------------------------------------------------------
// M4: MultiEmbed has TWO anonymous pointer fields.
// ---------------------------------------------------------------------------

// Log is an independent struct embedded alongside Base.
type Log struct {
	Level string
}

func (l *Log) Info(msg string) string {
	return "[" + l.Level + "] " + msg
}

// MultiEmbed embeds *Base AND *Log as anonymous fields.
type MultiEmbed struct {
	*Base
	*Log
	Tag string
}

// Echo is on MultiEmbed (not on Base or Log).
func (m *MultiEmbed) Echo() string {
	return m.Tag
}

// ---------------------------------------------------------------------------
// M5: ValEmbed uses a VALUE-typed (non-pointer) anonymous field.
// ---------------------------------------------------------------------------

// ValEmbed embeds Base by value (not *Base).
type ValEmbed struct {
	Base
	Extra string
}

func (v *ValEmbed) Tag() string {
	return v.Extra
}
