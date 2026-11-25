class Factory {
    static int take(String value) { return 1; }
    static int take(Object value) { return 2; }
    static int number(Integer value) { return 3; }
    static int number(Object value) { return 4; }

    int fromNull() { return number(Integer.valueOf(null)); }

    int run(char[] chars, Integer offset, Object value) {
        return take(String.valueOf(1)) + take(String.valueOf(chars, offset, 1))
            + take(java.lang.String.valueOf(value));
    }
}
