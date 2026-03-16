#pragma once
#include "animal.h"

class Flyer : public Animal {
public:
    void move() override;
    void fly();
};
