#include "service.h"

int main(void) {
    struct Service *svc = create_service();
    service_add_user(svc, "Alice", 25);
    service_add_user(svc, "Bob", 32);
    destroy_service(svc);
    return 0;
}
