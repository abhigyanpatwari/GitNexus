package com.example.handlers;

import com.example.fake.EventListener;
import com.example.fake.XxlJob;

public class CustomAnnotationHandler {
    @EventListener
    public void fakeEventHandler() {
        fakeStep();
    }

    @XxlJob("fakeJob")
    public void fakeXxlJobHandler() {
        fakeStep();
    }

    private void fakeStep() {
        fakeTerminal();
    }

    private void fakeTerminal() {}
}
