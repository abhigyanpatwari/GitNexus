package app

import models.User as U
import models.Repo as R

fun main() {
    val u = U("alice")
    val r = R("https://example.com")
    u.save()
    r.persist()
}
