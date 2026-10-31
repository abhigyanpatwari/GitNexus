package b;

import a.A;

public class B extends A {
    class Inner {
        String nested(B receiver) { return receiver.pick("x"); }
        String baseReceiver(A receiver) { return receiver.pick("x"); }
        String siblingReceiver(Sibling receiver) { return receiver.pick("x"); }
        class Deep {
            String deeplyNested(B receiver) { return receiver.pick("x"); }
        }
    }
    class NestedSubclass extends A {
        String enclosingSubclass(B receiver) { return receiver.pick("x"); }
    }
    static class Nested {
        String staticNested(B receiver) { return receiver.pick("x"); }
        String protectedStatic() { return A.staticPick("x"); }
    }
    public static void main(String[] args) {
        B receiver = new B();
        Inner inner = receiver.new Inner();
        System.out.println(String.join(",", inner.nested(receiver),
            inner.baseReceiver(receiver), inner.siblingReceiver(new Sibling()),
            inner.new Deep().deeplyNested(receiver),
            receiver.new NestedSubclass().enclosingSubclass(receiver),
            new Nested().staticNested(receiver), new Nested().protectedStatic()));
    }
}

class Sibling extends A {}
