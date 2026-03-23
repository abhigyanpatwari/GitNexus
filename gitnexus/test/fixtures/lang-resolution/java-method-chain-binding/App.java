class App {
    static User getUser() {
        return new User(new Address(new City("NYC")));
    }

    void processChain() {
        var user = getUser();
        var addr = user.address;
        var city = addr.getCity();
        city.save();
    }
}
