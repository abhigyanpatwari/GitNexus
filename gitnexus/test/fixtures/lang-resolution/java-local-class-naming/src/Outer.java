class Outer {
    void first() {
        class Local {
            void inner() {
                new Runnable() {
                    public void run() {}
                };
            }
        }

        class CtorHost {
            CtorHost() {
                class Local {
                    void inner() {}
                }
                new Local().inner();
            }
        }

        class NestedHost {
            class Member {
                void make() {
                    class Local {}
                }
            }
        }

        new Local().inner();
        new Runnable() {
            public void run() {}
        };
    }

    void second() {
        new Runnable() {
            public void run() {}
        };

        class Local {
            void inner() {}
        }

        new Local().inner();
    }
}
