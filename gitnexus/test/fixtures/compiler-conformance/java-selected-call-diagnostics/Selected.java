class Selected {
    Selected(int value) {}
    int keep(int value) { return value; }
    int other(int value) { return value; }

    int run() {
        new Selected("invalid");
        return keep(1) + other("invalid") + keep("invalid");
    }
}
