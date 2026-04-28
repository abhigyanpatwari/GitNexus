package models;

public abstract class Animal {
    public abstract String speak();

    public static String classify(String name) {
        return "mammal";
    }

    public boolean breathe() {
        return true;
    }
}
