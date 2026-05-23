package app

import logging.Logger

fun useCrossFileFactory() {
    val l = Logger.create("app")
    l.log("hello")
}

fun useCrossFileCrossover() {
    val l = Logger("explicit")
    l.create("nope")
}
