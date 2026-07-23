public enum EnumConst {
    A {
        public void hook() {
            log();
        }
    },
    B {
        public void hook() {
            System.out.println("B hook");
        }
    };

    public abstract void hook();

    public void log() {
        System.out.println("enum log");
    }
}

class Unrelated {
    public void caller() {
        hook();
    }

    public void dispatchToConstant() {
        EnumConst.A.hook();
    }

    public void dispatchInherited() {
        EnumConst.A.log();
    }
}
