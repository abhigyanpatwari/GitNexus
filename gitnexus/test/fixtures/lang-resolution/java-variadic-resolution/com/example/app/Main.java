package com.example.app;

import com.example.util.Logger;

public class Main {
    public void run() {
        Logger logger = new Logger();
        logger.record("hello", "world", "test");
    }
}
