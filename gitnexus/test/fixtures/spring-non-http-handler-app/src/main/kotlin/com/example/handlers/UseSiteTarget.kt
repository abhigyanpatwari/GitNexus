package com.example.handlers

import org.springframework.context.event.EventListener

class UseSiteTarget {
    @receiver:EventListener
    fun String.targetedReceiverIsNotAHandler() {
        useSiteStep()
    }

    private fun useSiteStep() {}
}
