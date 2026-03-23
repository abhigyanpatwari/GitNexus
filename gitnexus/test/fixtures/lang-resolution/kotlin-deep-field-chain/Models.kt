class City {
    var zipCode: String = ""

    fun getName(): String {
        return "city"
    }
}

class Address {
    var city: City = City()
    var street: String = ""

    fun save() {
        // persist address
    }
}

class User {
    var name: String = ""
    var address: Address = Address()

    fun greet(): String {
        return name
    }
}
