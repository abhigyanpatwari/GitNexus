package services

import models.Animal
import models.Dog

fun process() {
    val animal: Animal = Dog()
    animal.speak()
}
