package com.example.util;

public class Logger {
    public void record(String... args) {
        for (String a : args) System.out.println(a);
    }
}
