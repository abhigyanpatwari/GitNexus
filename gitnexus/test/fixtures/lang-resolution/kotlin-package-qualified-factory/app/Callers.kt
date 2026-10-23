package kqfapp

import kqfmod.make

fun namedCall(): Int {
    val x = make()
    return x.m()
}

fun qualifiedCall(): Int {
    val x = kqfmod.make()
    return x.m()
}

fun inlineQualified(): Int = kqfmod.make().m()

fun deepCall(): Int {
    val x = com.kqfacme.deep.make()
    return x.m()
}

fun inlineDeep(): Int = com.kqfacme.deep.make().m()

fun untypedCall(): Int {
    val x = kqfmod.untyped()
    return x.m()
}

fun untypedInline(): Int = kqfmod.untyped().m()

fun overloadedCall(): Int {
    val x = kqfmod.pick()
    return x.m()
}
