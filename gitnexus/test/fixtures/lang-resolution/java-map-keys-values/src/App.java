package src;

import java.util.Map;
import java.util.List;

public class App {
    public void processValues(Map<String, User> data) {
        for (var user : data.values()) {
            user.save();
        }
    }

    public void processList(List<User> users) {
        for (var user : users) {
            user.save();
        }
    }
}
