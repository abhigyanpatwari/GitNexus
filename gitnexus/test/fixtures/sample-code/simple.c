#include <stdio.h>

int add(int a, int b) {
    return a + b;
}

static int internal_helper(void) {
    return 0;
}

void print_message(const char* msg) {
    printf("%s\n", msg);
}
