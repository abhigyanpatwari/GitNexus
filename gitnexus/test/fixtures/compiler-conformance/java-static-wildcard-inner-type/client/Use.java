package client;

import static p.Owner.*;
import java.util.*;

class Use {
    static int selected(List<String> value) { return 1; }
    static int selected(Object value) { return 2; }

    int fromParameter(List<String> values) { return selected(values); }
    int fromCast() { return selected((List<String>) null); }
}
