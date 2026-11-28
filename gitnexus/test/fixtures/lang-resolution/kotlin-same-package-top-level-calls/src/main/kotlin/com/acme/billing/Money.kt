package com.acme.billing

fun computeTotal(amounts: List<Int>): Int = amounts.sum()

fun formatCents(cents: Int): String {
    val absoluteCents = kotlin.math.abs(cents.toLong())
    val sign = if (cents < 0) "-" else ""
    val dollars = absoluteCents / 100
    val remainder = (absoluteCents % 100).toString().padStart(2, '0')
    return "USD $sign$dollars.$remainder"
}
