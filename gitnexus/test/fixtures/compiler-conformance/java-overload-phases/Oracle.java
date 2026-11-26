import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.List;

class Oracle {
    static void phase(Integer value) {}
    static void phase(long value) {}
    static void boxed(long value) {}
    static void boxed(Number value) {}
    static void variable(String... values) {}
    static void variable(Object value) {}
    static void empty(Object... values) {}
    static void empty(String... values) {}
    static void generic(Collection<Number> values) {}
    static void generic(Object value) {}
    static void primitive(List<Long> values) {}
    static void primitive(Object value) {}
    static void array(Object[] values) {}
    static void array(Object value) {}

    void calls() {
        List<Long> ids = Arrays.asList(1L);
        phase(1);
        boxed(Integer.valueOf(1));
        variable("x");
        empty();
        generic(ids);
        generic(Arrays.asList(1L));
        generic(Collections.singletonList(1L));
        primitive(Arrays.asList(new long[]{1L}));
        array(new int[1][1]);
    }
}
