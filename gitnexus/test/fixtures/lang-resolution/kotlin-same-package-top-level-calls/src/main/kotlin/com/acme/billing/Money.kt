package com.acme.billing

fun computeTotal(amounts: List<Int>): Int = amounts.sum()

fun formatCents(cents: Int): String = "USD " + (cents / 100)
