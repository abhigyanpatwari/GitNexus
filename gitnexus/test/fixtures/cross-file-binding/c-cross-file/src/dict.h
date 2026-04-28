#ifndef DICT_H
#define DICT_H

typedef struct dictEntry {
    void *key;
    void *val;
} dictEntry;

dictEntry *dictFind(const char *key);
void *dictFetchValue(const char *key);

#endif
