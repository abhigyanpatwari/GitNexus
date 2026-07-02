package models;

public interface Task {
    String run();

    default String runAll() {
        return this.run();
    }
}
