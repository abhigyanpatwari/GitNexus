package services;

import static util.OneArg.writeAudit;
import static util.ZeroArg.writeAudit;

public class UserService {
    public void processUser() {
        writeAudit("hello");
    }
}
