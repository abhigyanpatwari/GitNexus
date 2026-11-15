package com.acme.app;

import com.acme.core.C;

public class App {
    public void process() {
        C c = new C();
        c.greet().save();
    }
}
