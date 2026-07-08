#ifndef USER_H
#define USER_H

struct User {
    char name[64];
    int age;
};

struct User *create_user(const char *name, int age);
void free_user(struct User *user);
int get_user_age(const struct User *user);

#endif
