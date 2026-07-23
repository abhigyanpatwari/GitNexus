public enum Plain {
    A;

    public void m() {
        System.out.println("plain m");
    }
}

class PlainCaller {
    public void callPlain() {
        Plain.A.m();
    }
}
