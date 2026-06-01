package models

// Bare control: constructor-call superclass `: Base()` parses as
// `(delegation_specifier (constructor_invocation (user_type (type_identifier))))`.
// This shape was already handled; it stays byte-identical and is the regression
// guard that the simple-base path is unchanged by the explicit_delegation widening.
class G : Base() {
    fun other() {}
}
