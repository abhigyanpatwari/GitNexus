#pragma once

class User {
public:
    void save();
};

class Service {
public:
    User* getUser();
};
