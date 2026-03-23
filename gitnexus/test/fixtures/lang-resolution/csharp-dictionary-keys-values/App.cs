using System.Collections.Generic;

public class App {
    public void ProcessValues(Dictionary<string, User> data) {
        foreach (var user in data.Values) {
            user.Save();
        }
    }

    public void ProcessList(List<User> users) {
        foreach (var user in users) {
            user.Save();
        }
    }
}
