class Prices {
    static int total(Object... items) { return 1; }
    static int total(String... items) { return 2; }
    int example(Object item) { return total() + total(item); }
}
