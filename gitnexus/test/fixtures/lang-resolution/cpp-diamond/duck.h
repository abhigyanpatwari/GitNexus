#pragma once
#include "flyer.h"
#include "swimmer.h"

class Duck : public Flyer, public Swimmer {
public:
    void speak() override;
};
