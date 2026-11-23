class Lexical {
    static class Base {
        String value;
    }

    static class Outer {
        Long value;

        class Inner extends Base {
            void pick(String value) {}
            void pick(Long value) {}

            void explicit() { pick(this.value); }
            void implicit() { pick(value); }
        }
    }

    static class Loop {
        Long item;
        String[] source(String value) { return new String[0]; }
        String[] source(Long value) { return new String[0]; }
        void body(String value) {}
        void body(Long value) {}

        void run() {
            for (String item : source(item)) {
                body(item);
            }
        }
    }
}
