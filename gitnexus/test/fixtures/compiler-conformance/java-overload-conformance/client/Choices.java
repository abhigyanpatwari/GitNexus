package client;

import static names.Names.Long;

class Choices {
    static void select(Long value) {}
    static void select(Number value) {}

    static void boxing() {
        select(1L); select(new Long());
    }

    static void choose(String value) {}
    static void choose(Integer value) {}

    static void ambiguous() {
        choose(null);
    }
}
