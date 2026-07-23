record Compact(int value) {
    Compact {
        class Local {
            void inner() {}
        }

        new Local().inner();
        new Runnable() {
            public void run() {}
        };
    }
}
