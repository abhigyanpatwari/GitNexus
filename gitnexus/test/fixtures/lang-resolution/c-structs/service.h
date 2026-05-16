#ifndef SERVICE_H
#define SERVICE_H

#include "user.h"

struct Service {
    struct User *admin;
    int user_count;
};

struct Service *create_service(void);
void service_add_user(struct Service *svc, const char *name, int age);
void destroy_service(struct Service *svc);

#endif
