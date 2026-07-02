import models.Box;
import models.Fallback;
import models.Shape;
import models.Target;
import models.Wrapper;

public class App {
    private Shape held;

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
}
