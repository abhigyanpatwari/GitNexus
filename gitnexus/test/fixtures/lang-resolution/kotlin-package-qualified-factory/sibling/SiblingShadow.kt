package kqfsibling

// `kqfmod` here is the same-package value declared in Value.kt.
fun siblingShadow(): Int {
    val x = kqfmod.make()
    return x.m()
}
