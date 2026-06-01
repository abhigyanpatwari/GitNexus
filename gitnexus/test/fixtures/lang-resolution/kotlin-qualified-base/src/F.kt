package models

// Interface-delegation base: `: Iface by d` parses as
// `(delegation_specifier (explicit_delegation (user_type (type_identifier)) <delegate>))`.
// The supertype is the LEADING `user_type` (Iface); the trailing delegate
// expression (`by d`) is NOT a supertype. The registry-primary synth previously
// DROPPED this shape, so production emitted no IMPLEMENTS edge here (#1951).
// Resolves by its simple name `Iface`, matching the legacy @heritage leg's
// normalizeSupertypeName(explicit_delegation) reduction.
class F(d: Iface) : Iface by d {
    fun extra() {}
}
