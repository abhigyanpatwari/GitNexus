class Address {
    var city: String = ""

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
