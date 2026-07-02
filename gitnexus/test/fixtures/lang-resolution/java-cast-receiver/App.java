import models.Box;
import models.Fallback;
import models.Shape;
import models.Target;
import models.Wrapper;

public class App {
    private Shape held;
    private Shape held2;

    // Simple cast: resolve via the cast type (Box), not obj's declared
    // type (Wrapper). Wrapper.open is the decoy.
    public void castSimple(Wrapper obj) {
        ((Box) obj).open();
    }

    // Nested/CFR-decompiler cast: the outermost meaningful cast (Target)
    // wins — not the inner (Object) noise cast, not expr's declared type
    // (Shape). Shape.render is the decoy.
    public void castNested(Shape expr) {
        ((Target) ((Object) expr)).render();
    }

    // Cast wrapping a this.field chain: the cast type (Target) wins over
    // the field's declared type (Shape). Shape.draw is the decoy.
    public void castThisField() {
        ((Target) ((Object) this.held)).draw();
    }

    // Cast to a resolvable-shape but locally-unindexed simple type
    // (String): resolution deliberately falls back to obj's OWN declared
    // type (Fallback). Unlike the unparseable-cast case (#2353 review F1:
    // generic/array/FQN cast types must resolve to nothing), a
    // simple-identifier cast to an unindexed type carries no better
    // information, and upcast casts make the declared type plausible.
    public void castUnindexedType(Fallback obj) {
        ((String) obj).act();
    }

    // ── Unparseable-cast scenarios (#2353 review F1) ─────────────────
    // Each cast below is type-shaped but UNPARSEABLE by the resolver
    // (generic / array / fully-qualified). Resolution must produce NO
    // call edge: falling through to the receiver's own declared type
    // (the decoy owning the same-named method) emits a confident wrong
    // edge.

    // Generic cast: Wrapper.open is the decoy (obj's declared type).
    public void castGeneric(Wrapper obj) {
        ((Box<String>) obj).open();
    }

    // Array cast: Wrapper.act2 is the decoy (obj's declared type).
    public void castArray(Wrapper obj) {
        ((Box[]) obj).act2();
    }

    // Fully-qualified cast: Wrapper.act3 is the decoy (obj's declared
    // type).
    public void castQualified(Wrapper obj) {
        ((models.Box) obj).act3();
    }

    // Generic-FQN cast over a this.field chain: Shape.act4 is the decoy
    // (the held2 field's declared type — and the generic argument, so a
    // future generic-arg extraction resolving List's method to the
    // element type would also be caught).
    public void castGenericFqnThisField() {
        ((java.util.List<Shape>) this.held2).act4();
    }

    // Non-cast parenthesized receiver: not a cast at all — must fall
    // through untouched (no crash, no fabricated edge). act5 is defined
    // on no class in this fixture, so any emitted edge is fabricated.
    public void nonCastParen(Wrapper x, Wrapper y, boolean flag) {
        (flag ? x : y).act5();
    }
}
