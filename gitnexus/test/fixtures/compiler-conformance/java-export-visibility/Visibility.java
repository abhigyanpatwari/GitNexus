public class Visibility {
    @interface Label { String value(); }
    @Label("public") void packageMethod() {}
    private void hidden() {}
    protected void inherited() {}
    public void exposed() {}

    static class Nested {
        void packageMethod() {}
    }
    interface Contract {
        void process();
        default void forward() {}
        private void helper() {}
    }
}
