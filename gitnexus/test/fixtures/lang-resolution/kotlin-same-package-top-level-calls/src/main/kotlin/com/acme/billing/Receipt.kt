package com.acme.billing

import com.acme.other.formatCents

class Receipt {
    fun computeTotal(amounts: List<Int>): Int = 0

    fun print(amounts: List<Int>): String {
        val total = computeTotal(amounts)
        return formatCents(total)
    }
}
