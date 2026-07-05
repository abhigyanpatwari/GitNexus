package models

// Interface-delegation base: `: Iface by d` parses as
// `(delegation_specifier (explicit_delegation (user_type (type_identifier)) <delegate>))`.
// The supertype is the LEADING `user_type` (Iface); the trailing delegate
// expression (`by d`) is NOT a supertype. An earlier synth DROPPED this shape,
// so production emitted no IMPLEMENTS edge here (#1951). Scope-resolution now
// resolves it by its simple name `Iface` — the documented explicit_delegation
// reduction.
class F(d: Iface) : Iface by d {
    fun extra() {}
}
