#include "service.h"
#include <stdlib.h>

struct Service *create_service(void) {
    struct Service *svc = malloc(sizeof(struct Service));
    svc->admin = create_user("admin", 30);
    svc->user_count = 0;
    return svc;
}

void service_add_user(struct Service *svc, const char *name, int age) {
    struct User *user = create_user(name, age);
    svc->user_count++;
    free_user(user);
}

void destroy_service(struct Service *svc) {
    free_user(svc->admin);
    free(svc);
}
