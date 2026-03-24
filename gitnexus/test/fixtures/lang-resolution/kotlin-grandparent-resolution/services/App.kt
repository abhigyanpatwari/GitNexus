package services

import models.C

fun process() {
    val c = C()
    c.greet().save()
}
