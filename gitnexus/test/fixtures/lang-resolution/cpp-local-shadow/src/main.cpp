#include "utils.h"

// Local function shadows included save
void save(const char* data) {
    printf("local save: %s\n", data);
}

void run() {
    save("test");
}

int main() {
    run();
    return 0;
}
