#include "models.h"

void run() {
    auto client = ns::HttpClient{};
    client.connect();
    client.send();
}
