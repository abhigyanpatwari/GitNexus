class Prices {
    static int sum(Object... items) { return 1; }
    static int sum(String... items) { return 2; }
    int example(Object item) { return sum() + sum(item); }
}
