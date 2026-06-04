template<class T>
void pick(T* lhs, T rhs) {
}

template<class T>
void pick(T lhs, T* rhs) {
}

void run() {
  int n = 0;
  int* p = &n;
  pick(p, p);
}
