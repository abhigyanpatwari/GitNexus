package p;

import lombok.Getter;
import p.Outer.Roots.Shadow;

class Imported extends Shadow {
    @Getter(local = 1) int hidden;
}
