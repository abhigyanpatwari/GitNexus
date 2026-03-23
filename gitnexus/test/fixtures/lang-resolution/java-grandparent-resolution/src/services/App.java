package services;

import models.C;

public class App {
    public void process() {
        C c = new C();
        c.greet().save();
    }
}
