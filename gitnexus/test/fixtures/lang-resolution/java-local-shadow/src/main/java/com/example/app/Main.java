package com.example.app;

import com.example.utils.Logger;

public class Main {
    // Local method shadows imported Logger.save
    public static void save(String data) {
        System.out.println("local save: " + data);
    }

    public static void run() {
        save("test");
    }
}
