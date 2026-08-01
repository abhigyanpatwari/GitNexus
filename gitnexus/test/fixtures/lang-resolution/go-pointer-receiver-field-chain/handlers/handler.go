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

// #2766 / U8 control: SAME-PACKAGE field receiver through a pointer receiver.
// Before the base fix this emitted an ACCESSES edge to the method and NO CALLS
// edge — the member name resolved while the CALLS leg, which needs the
// receiver's class, did not. It is the shape that made the miss look like an
// edge-classification bug rather than a receiver-typing one.
type LocalDep struct{}

func (d *LocalDep) Work() error { return nil }

type LocalHost struct {
	dep *LocalDep
}

func (h *LocalHost) RunSamePackage() error {
	return h.dep.Work()
}

// #2782 review: a FUNC-TYPED STRUCT FIELD is dispatched with exactly the same
// `x.f()` syntax as a method, so a selector in callee position is NOT always a
// phantom read. `Callbacks` is the shape of every callback struct, hook struct
// and hand-rolled mock in real Go (`mock.DoFunc`, `opts.OnEvent`), and the field
// read is their ONLY ACCESSES evidence — dropping callee-position reads at the
// capture layer erased it.
//
// The receivers below are deliberately BARE names rather than field chains:
// `h.x.y` reads do not resolve at all today (a separate, pre-existing compound
// receiver gap), so a chained spelling would assert nothing either way.
type Callbacks struct {
	OnEvent func() error
	Label   string
}

// The row the callee-position drop deleted. `OnEvent` is a field, so the
// selector is a genuine read; the call goes through the value it holds.
func CallFuncField(c *Callbacks) error {
	return c.OnEvent()
}

// Control: a plain (non-func) field read is never in callee position.
func ReadPlainField(c *Callbacks) string {
	return c.Label
}

// Control: a METHOD VALUE is not in callee position either, so its read must
// survive even though the tail resolves to a Method — the kind test alone would
// wrongly suppress it.
func MethodValue(i *repository.Impl) func() error {
	f := i.DoWork
	return f
}

// Control: the ORIGINAL defect. A real method call emits CALLS only; an ACCESSES
// to the same method at the same position is the phantom that must stay gone.
func RealMethodCall(i *repository.Impl) error {
	return i.DoWork()
}
