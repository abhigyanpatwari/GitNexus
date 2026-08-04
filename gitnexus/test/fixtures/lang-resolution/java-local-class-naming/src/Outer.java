class Outer {
    class Cyclic {
        void member() {}
    }

    class MemberHost {
        void make() {
            class Local {
                void ordinaryMemberHit() {}
            }

            new Local().ordinaryMemberHit();
        }
    }

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

    void declarationOrder() {
        new Cyclic().member();

        class Cyclic {
            void local() {}
        }

        new Cyclic().local();
    }

    void blocks() {
        {
            class Local {
                void firstBlock() {}
            }

            new Local().firstBlock();
        }

        {
            class Local {
                void secondBlock() {}
            }

            new Local().secondBlock();
        }
    }

    static {
        class StaticLocal {
            void staticHit() {}
        }

        new StaticLocal().staticHit();
    }

    {
        class InstanceLocal {
            void instanceHit() {}
        }

        new InstanceLocal().instanceHit();
    }

    Runnable task = () -> {
        class LambdaLocal {
            void lambdaHit() {}
        }

        new LambdaLocal().lambdaHit();
    };

    Runnable anonymousTask = new Runnable() {
        {
            class Local {
                void anonymousHit() {}
            }

            new Local().anonymousHit();
        }

        public void run() {}
    };
}
