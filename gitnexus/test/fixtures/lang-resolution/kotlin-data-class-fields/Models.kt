class Address {
    var city: String = ""

    fun save() {
        // persist address
    }
}

data class User(
    val name: String,
    val address: Address,
    val age: Int
)
