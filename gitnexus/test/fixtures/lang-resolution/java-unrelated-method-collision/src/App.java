public class A {
    public void helper() {
        System.out.println("A.helper");
    }
}

class B {
    public void work() {
        helper();
    }
}
