package com.kqfacme.deep

class D {
    fun m(): Int = 3
}

// Same name as kqfmod.make: only the package path tells them apart.
fun make(): D = D()
