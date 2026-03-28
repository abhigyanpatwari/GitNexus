package impl;

import contracts.Action;

public class LogEvent implements Action {
    public String execute() {
        return "event logged";
    }

    public int priority() {
        return 2;
    }
}
