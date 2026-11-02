package kqfmod

// The package's factories live in a different file from the types they
// return: a package spans files.
fun make(): C = C()

// No return annotation: the call's type is unknown, not absent.
fun untyped() = C()

// Overloads: the callee path alone cannot tell them apart.
fun pick(): C = C()

fun pick(flag: Boolean): C = C()
