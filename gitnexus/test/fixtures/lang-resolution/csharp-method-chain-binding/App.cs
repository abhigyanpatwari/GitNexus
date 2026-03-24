class City {
    public string Name { get; set; }
    public City(string name) { Name = name; }
    public bool Save() { return true; }
}

class Address {
    public City City { get; set; }
    public Address(City city) { City = city; }
    public City GetCity() { return City; }
}

class User {
    public Address Address { get; set; }
    public User(Address address) { Address = address; }
}

class App {
    static User GetUser() {
        return new User(new Address(new City("NYC")));
    }

    void ProcessChain() {
        var user = GetUser();
        var addr = user.Address;
        var city = addr.GetCity();
        city.Save();
    }
}
