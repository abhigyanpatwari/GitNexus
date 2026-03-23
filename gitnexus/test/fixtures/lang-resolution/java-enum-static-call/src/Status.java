public enum Status {
    OK,
    ERROR;

    public static Status fromCode(int code) {
        return code == 200 ? OK : ERROR;
    }

    public String label() {
        return this.name().toLowerCase();
    }
}
