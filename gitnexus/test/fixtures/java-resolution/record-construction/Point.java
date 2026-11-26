package probe;
          public record Point(int x) {
            private static final int SEED = initialize();
            private static int initialize() { return 1; }
          }