public interface Validator {
    default boolean validate() {
        return true;
    }
}
