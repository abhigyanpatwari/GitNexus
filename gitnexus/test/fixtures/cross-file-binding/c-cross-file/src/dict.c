#include "dict.h"
#include <stdlib.h>

dictEntry *dictFind(const char *key) {
    return NULL;
}

void *dictFetchValue(const char *key) {
    dictEntry *entry = dictFind(key);
    if (entry) return entry->val;
    return NULL;
}
