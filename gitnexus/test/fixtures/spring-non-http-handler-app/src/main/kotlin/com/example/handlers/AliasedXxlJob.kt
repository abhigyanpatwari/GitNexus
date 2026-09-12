package com.example.handlers

import com.xxl.job.core.handler.annotation.XxlJob as ManagedJob

class AliasedXxlJob {
    @ManagedJob(JOB_NAME)
    fun runKotlinJob() {
        executeJob()
    }

    private fun executeJob() {
        recordCompletion()
    }

    private fun recordCompletion() {}

    companion object {
        const val JOB_NAME = "kotlinJobHandler"
    }
}
