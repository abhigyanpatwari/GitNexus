package probe;

public record Point(int x, int y) {
    public int sum() {
        return x + y;
    }

    public int scaled(int factor) {
        return sum() * factor;
    }
}
