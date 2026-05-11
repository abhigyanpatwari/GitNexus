package com.example.app;

import com.example.util.Logger;
import com.example.util.Formatter;

public class Main {
    public void run() {
        Logger logger = new Logger();
        logger.record("hello", "world", "test");

        Formatter fmt = new Formatter();
        // 2-arg call: satisfies fixed prefix (level) + 1 vararg
        fmt.format(1, "hello");
        // 3-arg call: satisfies fixed prefix (level) + 2 varargs
        fmt.format(2, "hello", "world");
    }
}

