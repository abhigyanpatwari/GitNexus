package com.acme.app

import com.acme.core.C

class App {
    fun process() {
        val c = C()
        c.greet().save()
    }
}
