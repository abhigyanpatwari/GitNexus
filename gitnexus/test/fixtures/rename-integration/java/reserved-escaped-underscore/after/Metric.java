class Metric {
    int measure(int value) { return value + 1; }
    int report() { return measure(3); }
    String label = "measure";
    // measure stays in this comment.
}
