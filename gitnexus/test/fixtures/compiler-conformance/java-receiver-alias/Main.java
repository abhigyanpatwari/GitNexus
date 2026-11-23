class User {
    void save() {}
}

class Service {
    User getUser() { return new User(); }
}

class App {
    void bound(Service service) {
        var user = service.getUser();
        user.save();
    }

    void alias(Service service) {
        var user = service.getUser();
        var copy = user;
        copy.save();
    }
}
