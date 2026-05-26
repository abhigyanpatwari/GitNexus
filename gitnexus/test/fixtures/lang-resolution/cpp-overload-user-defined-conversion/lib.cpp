#include "lib.h"

Wrap::Wrap(int value) {}
WrapA::WrapA(int value) {}
WrapB::WrapB(int value) {}
ExplicitWrap::ExplicitWrap(int value) {}

void Service::f(Wrap value) {}
void Service::f(double value) {}
void Service::g(Wrap value) {}
void Service::h(WrapA value) {}
void Service::h(WrapB value) {}
void Service::e(Wrap value) {}
void Service::e(ExplicitWrap value) {}
