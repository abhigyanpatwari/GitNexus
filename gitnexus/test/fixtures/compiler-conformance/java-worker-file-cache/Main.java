class Main {
    int first() { return second(); }
    int second() { return 2; }
    int run() { return new Base().value(); }
}
