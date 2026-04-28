package services

class User

class UserService {
    fun lookup(id: Int): User? {
        return null
    }

    fun lookup(name: String): User? {
        return null
    }

    fun callById() {
        lookup(42)        // literal Int → must resolve to lookup(Int) only
    }

    fun callByName() {
        lookup("alice")   // literal String → must resolve to lookup(String) only
    }
}
