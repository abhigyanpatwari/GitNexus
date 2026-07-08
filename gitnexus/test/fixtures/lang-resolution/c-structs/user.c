#include "user.h"
#include <stdlib.h>
#include <string.h>

struct User *create_user(const char *name, int age) {
    struct User *user = malloc(sizeof(struct User));
    strncpy(user->name, name, sizeof(user->name) - 1);
    user->age = age;
    return user;
}

void free_user(struct User *user) {
    free(user);
}

int get_user_age(const struct User *user) {
    return user->age;
}
