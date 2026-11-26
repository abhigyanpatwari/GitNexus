class Calls {
    int accept(int value) { return value; }
    int accept(String value) { return value.length(); }
    int good() { return accept(1); }
    int bad() { return accept(missing()); }
}
