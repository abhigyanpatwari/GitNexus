#include "external.hpp"

class Worker : public External {
public:
    int target() override { return 1; }
};
