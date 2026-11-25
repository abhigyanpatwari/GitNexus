class NullTie {
    void choose(String x) {}
    void choose(Integer x) {}
    void run() { choose(null); }
}

class Crossed {
    void choose(String x, Object y) {}
    void choose(Object x, String y) {}
    void run() { choose("a", "b"); }
}

class PolyTie {
    void choose(java.util.List<Number> x) {}
    void choose(java.util.Collection<Integer> x) {}
    void run() { choose(java.util.Arrays.asList(1)); }
}

class WidenThenBox {
    void choose(Long x) {}
    void run() { choose(1); }
}

class StaticInvocation {
    static void choose(Object x) {}
    void choose(String x) {}
    static void run() { choose("x"); }
}

class TypeQualified {
    static void choose(Object x) {}
    void choose(String x) {}
    static void run() { TypeQualified.choose("x"); }
}
