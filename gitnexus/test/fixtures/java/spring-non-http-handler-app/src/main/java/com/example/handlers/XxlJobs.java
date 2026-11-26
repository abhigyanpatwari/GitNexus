package com.example.handlers;

import com.xxl.job.core.handler.annotation.XxlJob;

public class XxlJobs {
    private static final String JOB_NAME = "constantJobHandler";

    @XxlJob("literalJobHandler")
    public void runLiteralJob() {
        executeJob();
    }

    @XxlJob(JOB_NAME)
    public void runConstantJob() {
        executeJob();
    }

    private void executeJob() {
        recordCompletion();
    }

    private void recordCompletion() {}
}
