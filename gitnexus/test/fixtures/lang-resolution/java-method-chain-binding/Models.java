class City {
    String name;
    City(String name) { this.name = name; }
    boolean save() { return true; }
}

class Address {
    City city;
    Address(City city) { this.city = city; }
    City getCity() { return city; }
}

class User {
    Address address;
    User(Address address) { this.address = address; }
}
