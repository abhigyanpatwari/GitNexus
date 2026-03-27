package impl;

import contracts.Action;

public class SendEmail implements Action {
    public String execute() {
        return "email sent";
    }

    public int priority() {
        return 1;
    }
}
