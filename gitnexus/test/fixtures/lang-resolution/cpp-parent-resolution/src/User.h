#pragma once
#include "BaseModel.h"

class User : public BaseModel {
public:
    const char* serialize() { return ""; }
};
