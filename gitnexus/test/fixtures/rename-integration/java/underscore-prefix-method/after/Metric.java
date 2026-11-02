class Metric {
    int _measure(int value) { return value + 1; }
    int report() { return _measure(3); }
    String label = "measure";
    // measure stays in this comment.
}
