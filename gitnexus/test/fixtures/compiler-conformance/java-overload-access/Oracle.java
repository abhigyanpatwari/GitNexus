class AccessFilter {
    private void accessFiltered(String value) {}
    public void accessFiltered(Object value) {}
}

class Oracle {
    static Object external() { return null; }

    void call(AccessFilter receiver) {
        Object argument = external();
        receiver.accessFiltered(external());
        receiver.accessFiltered(argument);
        receiver.accessFiltered("x");
    }
}
