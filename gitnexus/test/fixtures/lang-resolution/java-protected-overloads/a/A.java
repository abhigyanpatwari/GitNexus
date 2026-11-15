package a;

public class A {
    protected String pick(String value) { return "string"; }
    public String pick(Object value) { return "object"; }
    protected static String staticPick(String value) { return "static-string"; }
    public static String staticPick(Object value) { return "static-object"; }
}
