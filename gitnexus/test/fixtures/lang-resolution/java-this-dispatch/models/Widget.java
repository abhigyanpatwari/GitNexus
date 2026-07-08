package models;

public class Widget {
    public int size;

    public int size() {
        return 7;
    }

    public int describe() {
        int current = this.size;
        return current;
    }

    public int measure() {
        return this.size();
    }
}
