class Prices {
    static int objects() { return 1; }
    static int strings() { return 2; }

    static int total(final /* units */ Object... items) { return objects(); }
    static int total(final /* units */ String... items) { return strings(); }

    static int rows(int count, Object[]... items) { return objects(); }
    static int rows(int count, String[]... items) { return strings(); }

    static int example(Object item) {
        return total() + total(item) + rows(0);
    }
}
