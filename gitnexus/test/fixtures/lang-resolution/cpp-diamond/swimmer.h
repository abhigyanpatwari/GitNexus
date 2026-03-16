#pragma once
#include "animal.h"

class Swimmer : public Animal {
public:
    void move() override;
    void swim();
};
