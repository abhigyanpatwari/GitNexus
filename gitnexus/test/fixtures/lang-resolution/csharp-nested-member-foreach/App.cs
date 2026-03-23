using System.Collections.Generic;

public class App {
    private Dictionary<string, User> data;

    public void ProcessValues() {
        foreach (var user in this.data.Values) {
            user.Save();
        }
    }

    public void ProcessKeys() {
        foreach (var key in this.data.Keys) {
            key.ToString();
        }
    }
}
