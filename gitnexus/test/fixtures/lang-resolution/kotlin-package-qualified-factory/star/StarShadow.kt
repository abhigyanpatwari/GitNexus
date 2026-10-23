package kqfstar

import kqfvalues.*

// `kqfmod` here is the value the star import brings in, not the package.
fun starShadow(): Int {
    val x = kqfmod.make()
    return x.m()
}
