class Address {
  String city = '';

  void save() {
    // persist address
  }
}

class User {
  String name = '';
  Address address = Address();

  String greet() {
    return name;
  }
}
