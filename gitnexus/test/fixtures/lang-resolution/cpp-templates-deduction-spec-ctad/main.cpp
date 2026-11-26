#include "templates.h"

void positiveVecIntegral() {
  std::vector<int> values;
  consumeVec(values);
}

void positiveVecFloating() {
  std::vector<double> values;
  consumeConstRefVec(values);
}

void negativeVecPointerElement() {
  // Element is `int*`, NOT integral and NOT floating-point -> neither SFINAE overload matches.
  std::vector<int*> ptrs;
  consumeVec(ptrs);
}

void positivePointerPeel(const int* ip, const double* dp) {
  consumePtr(ip);
  consumePtr(dp);
}

void negativeMultiOccurrence() {
  multiParam(1, 2);
}

void negativeMultiPair() {
  std::pair<int, int> p;
  multiPair(p);
}

void positivePartialSpecPointer() {
  S<int*> sp;
  sp.ptrSpecHit();
}

void positivePartialOrderConstPointer() {
  S<const int*> scp;
  scp.constPtrSpecHit();
}

void positiveExplicitBeatsPartial() {
  S<void*> svp;
  svp.voidPtrExplicitHit();
}

void positivePrimaryUnmatched() {
  S<double> sd;
  sd.primaryHit();
}

void negativeAmbiguousPartialSpecFallback() {
  Dual<int, int> d;
  d.dualPrimaryHit();
  d.leftSpecHit();
  d.rightSpecHit();
}

void positiveQualifiedPartialSpec() {
  ns::Holder<int*> h;
  h.nsPtrSpecHit();
}

void positiveCtadLiteralInt() {
  Box b{42};
  b.boxIntSpecHit();
}

void positiveCtadAutoPointer(int* p) {
  auto b = Box{p};
  b.boxPtrSpecHit();
}

void positiveCtadDeductionGuide() {
  Box b{"hello"};
  b.boxGuideSpecHit();
}

void positiveCtadVectorFeedsDeduction() {
  std::vector nums{1, 2, 3};
  consumeVec(nums);
}

void negativeCtadUnknownArgFallback() {
  Box b{opaqueSource()};
  b.boxPrimaryHit();
  b.boxIntSpecHit();
}

void negativeNonTemplateClassUntouched() {
  PlainRecord rec(7);
  rec.plainHit();
}
