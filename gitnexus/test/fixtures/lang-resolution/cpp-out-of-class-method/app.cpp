#include "myclass.h"

void callGreetDefault() {
    MyClass obj;
    obj.greet();
}

void callGreetMsg() {
    MyClass obj;
    obj.greet("hi");
}

void callGetNameDefault() {
    MyClass obj;
    obj.getName();
}

void callGetNameById() {
    MyClass obj;
    obj.getName(42);
}
