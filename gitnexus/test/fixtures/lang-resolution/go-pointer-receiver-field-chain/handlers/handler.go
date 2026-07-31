// Regression fixture for #2766.
//
// A Go method with a POINTER receiver binds its receiver to the literal string
// `*Holder` (synthesizeGoReceiverBinding stores typeNode.text raw, deliberately,
// because method-owners.ts consumes the `*T` vs `T` distinction to model Go's
// value and pointer method sets). Before the decoration fallback in
// findClassBindingInScope, that string matched no class binding, so receiver
// typing declined at the BASE and every `h.field.Method()` here emitted no CALLS
// edge — the dominant Go idiom, silently missing from the graph.
//
// The value-receiver twin at the bottom is the control: it resolved before the
// fix and must keep resolving after it. Field decoration is NOT the variable —
// Go already normalizes field type bindings at capture via normalizeGoTypeName.
package handlers

import "fixture/repository"

type Holder struct {
	thing repository.Thing
	impl  *repository.Impl
	cart  *repository.CartRepo
}

// Pointer receiver, interface-typed cross-package field.
func (h *Holder) RunInterface() error {
	return h.thing.DoWork()
}

// Pointer receiver, concrete-typed cross-package field.
func (h *Holder) RunConcrete() error {
	return h.impl.DoWork()
}

// Pointer receiver, concrete-typed cross-package field returning a value.
func (h *Holder) RunCart(tx int) *repository.CartRepo {
	return h.cart.WithTx(tx)
}

// Control: a local variable receiver typed in the same function resolved even
// before the fix, via the text cascade rather than the decorated base.
func (h *Holder) RunLocal() error {
	local := &repository.Impl{}
	return local.DoWork()
}

type ValueHolder struct {
	impl *repository.Impl
}

// Control: VALUE receiver. Binds as `ValueHolder` with no decoration, so this
// resolved before the fix and must not change.
func (v ValueHolder) RunFromValueReceiver() error {
	return v.impl.DoWork()
}
