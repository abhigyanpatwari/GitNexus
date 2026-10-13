package app
import models.`Worker` as W
fun run(): Int { val item = W(); return item.fetch() }
