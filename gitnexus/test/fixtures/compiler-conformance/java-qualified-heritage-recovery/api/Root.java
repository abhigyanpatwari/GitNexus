package api;

interface Left { class Clash {} }
interface Right { class Clash {} }

class PackageBase { public static class Nested {} }

public class Root extends PackageBase implements Left, Right {
    public static class Open {}
    private static class Hidden {}
}
