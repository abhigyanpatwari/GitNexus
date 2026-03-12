#ifndef LOGGER_H
#define LOGGER_H

#include <cstdarg>
#include <cstdio>

void log_entry(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vprintf(fmt, args);
    va_end(args);
}

#endif
