package p;

import lombok.Getter;
import static p.Outer.Roots;

class StaticImport extends Roots.Plain {
    @Getter int quantity;
}
