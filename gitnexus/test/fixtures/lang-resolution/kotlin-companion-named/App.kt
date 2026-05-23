// Fixture for U4 (#1756 remediation plan): named companions, companions
// containing nested classes, and inner-class-plus-companion mixes.
//
// The pre-U4 `populateCompanionMembersOnEnclosingClass` guard used
// `parent.ownedDefs.some(isClassLike) → continue`, which silently
// bypassed two real shapes:
//   - named companions (`companion object Helper { ... }`) — the
//     `Helper` `type_identifier` registered as a class-like def on
//     the companion scope, hiding the companion-ness; and
//   - companions containing nested classes (`companion object {
//     class Token; fun create() }`) — the nested class def lived on
//     the companion scope, again hiding the companion-ness.
// Both bypasses left companion methods unpromoted and unmarked,
// breaking class-name dispatch (`Outer.create()`) and crossover
// suppression (`outer.create()`) for those shapes.

class Outer {
    fun greet() {}
    companion object Helper {
        fun create(): Outer = Outer()
    }
}

class WithNested {
    companion object {
        class Token
        fun forge(): WithNested = WithNested()
    }
}

class InnerClassAndCompanion {
    class Inner
    companion object {
        fun build(): InnerClassAndCompanion = InnerClassAndCompanion()
    }
}

// Happy path: named companion dispatched through the class name.
fun useNamed() { Outer.create() }

// Crossover (adversarial): `o.create()` on an instance is a compile
// error in Kotlin — companion-object methods can only be called via
// the class name. Must emit no CALLS edge.
fun useNamedCrossover() {
    val o = Outer()
    o.create()
}

// Happy path: companion containing a nested class — the companion
// method should still be promoted onto the enclosing class.
fun useNested() { WithNested.forge() }

// Mix: outer class has BOTH a nested class AND a companion object.
// The companion method is promoted (new behavior); the nested class
// stays owned by its own scope (existing behavior).
fun useInnerMix() {
    InnerClassAndCompanion.build()
    val i = InnerClassAndCompanion()
    i.build()
}
