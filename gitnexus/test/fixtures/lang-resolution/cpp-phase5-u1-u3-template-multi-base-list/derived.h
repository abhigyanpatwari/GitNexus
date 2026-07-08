#pragma once

#include "base.h"

template<class T>
struct Derived : A<T>, B<T> {};
