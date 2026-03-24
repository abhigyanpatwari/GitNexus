class City(val name: String) {
    fun save(): Boolean = true
}

class Address(val city: City) {
    fun getCity(): City = city
}

class User(val address: Address)

fun getUser(): User = User(Address(City("NYC")))

fun processChain() {
    val user = getUser()
    val addr = user.address
    val city = addr.getCity()
    city.save()
}
