package com.acme.billing

class InvoiceService {
    fun render(amounts: List<Int>): String {
        val total = computeTotal(amounts)
        return formatCents(total)
    }
}
