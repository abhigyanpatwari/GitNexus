package app

import utils.save

// Local function shadows imported save
fun save(data: String) {
    println("local save: $data")
}

fun run() {
    save("test")
}
