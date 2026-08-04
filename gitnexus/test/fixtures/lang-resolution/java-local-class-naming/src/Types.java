class Types {
    void types() {
        enum E {
            A;

            void enumHit() {}
        }

        record R(int x) {
            void recordHit() {}
        }

        interface I {
            void run();
        }

        E.A.enumHit();
        new R(1).recordHit();
        I implementation = new I() {
            public void run() {}
        };
        implementation.run();
    }
}
