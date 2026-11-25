import java.util.function.Consumer;

class Wildcards {
    static class Item { void save() {} }

    void upper(Consumer<?extends Item> action) {}
    void lower(Consumer<?super Item> action) {}
    void spaced(Consumer<? super Item> action) {}
    void commented(Consumer<?/* bound */extends/* name */Item> action) {}

    void run() {
        upper(item -> item.save());
        lower(item -> item.save());
        spaced(item -> item.save());
        commented(item -> item.save());
    }
}
