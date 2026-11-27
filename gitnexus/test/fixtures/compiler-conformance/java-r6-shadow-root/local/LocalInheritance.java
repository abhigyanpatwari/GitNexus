package local;

import anon.Base;

class LocalInheritance {
    static class First { void save() {} }
    static class Second { void save() {} }

    void firstScope() {
        class Base extends anon.Base {
            class Item { void ping() {} }
            First field;
        }
        class Child extends Base {
            void member(Item item) { item.ping(); }
            void inheritedField() { field.save(); }
        }
    }

    void secondScope() {
        class Base {
            class Item { void ping() {} }
            Second field;
        }
        class Child extends Base {
            void member(Item item) { item.ping(); }
            void inheritedField() { field.save(); }
        }
    }
}

class MemberInheritance {
    static class Base extends anon.Base {
        static class Item { void ping() {} }
    }
    static class Child extends Base {
        void member(Item item) { item.ping(); }
    }
}
