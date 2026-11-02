package com.example.messaging

/**
 * Destination names shared the way Kotlin shares them — an `object` member
 * rather than a `static final` field.
 *
 * The Java side of this fixture proves constant folding through
 * `Topics.SHIPMENTS`; this proves the KOTLIN binding is wired into the same
 * cascade, which is a separate fact: the fold reaches destination resolution
 * only when the owning provider declares `extractModuleConstants` AND
 * `foldRoutePathOperands`, and Kotlin declares both.
 */
object KotlinTopics {
    const val INVENTORY = "kotlin.constant.v1"
}
