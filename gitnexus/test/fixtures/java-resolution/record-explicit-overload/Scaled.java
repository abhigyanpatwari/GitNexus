package probe;
public record Scaled(int x, int y) { int x(int factor) { return x * factor; } }
