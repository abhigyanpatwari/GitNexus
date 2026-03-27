package services;

import contracts.Action;

public class ActionRunner {
    private final Action action;

    public ActionRunner(Action action) {
        this.action = action;
    }

    public void run() {
        action.execute();
        action.priority();
    }
}
