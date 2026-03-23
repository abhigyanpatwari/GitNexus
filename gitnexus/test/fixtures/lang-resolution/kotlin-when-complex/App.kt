import models.User
import models.Repo
import models.Admin

// Three-arm when: each arm should resolve obj to its narrowed type
fun processThreeArms(obj: Any) {
    when (obj) {
        is User -> obj.save()
        is Repo -> obj.save()
        is Admin -> obj.save()
    }
}

// Multiple method calls within a single when arm
fun processMultiCall(obj: Any) {
    when (obj) {
        is User -> {
            obj.validate()
            obj.save()
        }
        is Repo -> {
            obj.validate()
            obj.save()
        }
    }
}

// when with else branch — else should NOT narrow the type
fun processWithElse(obj: Any) {
    when (obj) {
        is User -> obj.save()
        else -> println(obj)
    }
}
