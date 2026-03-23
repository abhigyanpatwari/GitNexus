package services

class User

class UserService {
    fun lookup(id: Int): User? {
        return null
    }

    fun lookup(name: String): User? {
        return null
    }

    fun run() {
        lookup(42)        // literal Int → should disambiguate to lookup(Int)
        lookup("alice")   // literal String → should disambiguate to lookup(String)
    }
}
