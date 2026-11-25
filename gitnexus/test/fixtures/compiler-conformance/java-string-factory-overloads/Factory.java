class Factory {
    static int take(String value) { return 1; }
    static int take(Object value) { return 2; }

    int run(char[] chars, Integer offset, Object value) {
        return take(String.valueOf(1)) + take(String.valueOf(chars, offset, 1))
            + take(java.lang.String.valueOf(value));
    }
}
