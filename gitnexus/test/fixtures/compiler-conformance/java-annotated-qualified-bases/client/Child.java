package client;
class Child extends /* superclass */ api.@Tag("https://example.org/x") Base
        implements api.@Tag("/* this string is not a comment */") Signal {
    void run() {
        chosen();
        ping();
    }
}
