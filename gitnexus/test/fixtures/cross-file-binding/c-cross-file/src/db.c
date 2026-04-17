#include "server.h"

void lookupKey(const char *key) {
    dictEntry *entry = dictFind(key);
    if (entry) {
        void *val = entry->val;
    }
}

void dbGet(const char *key) {
    void *val = dictFetchValue(key);
}
