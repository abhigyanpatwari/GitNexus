package util;

public final class FormatUtil {
    public static String format(Object value) {
        return value == null ? "" : value.toString();
    }
}
