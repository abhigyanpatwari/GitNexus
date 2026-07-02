package models;

public class SlowTask implements Task {
    public String run() {
        return "slow";
    }
}
