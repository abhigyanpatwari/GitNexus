class User {
    public string Name { get; set; }

    public User(string name) {
        Name = name;
    }

    public bool Save() {
        return true;
    }
}

class App {
    static User GetUser(string name) {
        return new User(name);
    }

    void ProcessUser() {
        var user = GetUser("alice");
        user.Save();
    }
}
