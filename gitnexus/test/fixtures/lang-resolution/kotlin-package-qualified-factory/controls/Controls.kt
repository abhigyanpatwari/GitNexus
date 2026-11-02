package kqfctl

import kqfmod.Other
import kqfvalues.kqfmod

class Shadow {
    fun make(): Other = Other()
}

class Holder {
    companion object {
        fun create(): Other = Other()
    }
}

object Registry {
    fun build(): Other = Other()
}

// A value named like the package wins over the package path.
fun localShadow(): Int {
    val kqfmod = Shadow()
    val x = kqfmod.make()
    return x.m()
}

fun parameterShadow(kqfmod: Shadow): Int {
    val x = kqfmod.make()
    return x.m()
}

class PropertyShadow(private val kqfmod: Shadow) {
    fun run(): Int {
        val x = kqfmod.make()
        return x.m()
    }
}

// Bound by `import kqfvalues.kqfmod`.
fun importedShadow(): Int {
    val x = kqfmod.make()
    return x.m()
}

fun companionMember(): Int {
    val x = Holder.create()
    return x.m()
}

fun objectMember(): Int {
    val x = Registry.build()
    return x.m()
}
