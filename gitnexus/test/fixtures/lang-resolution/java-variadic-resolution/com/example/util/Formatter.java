package com.example.util;

public class Formatter {
    /** Varargs with a required fixed prefix — 0-arg calls should be rejected. */
    public void format(int level, String... args) {
        for (String a : args) System.out.println(level + ": " + a);
    }
}
