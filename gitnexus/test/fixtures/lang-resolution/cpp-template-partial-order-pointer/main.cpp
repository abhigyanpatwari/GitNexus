template<class T>
void pick(T value) {
}

template<class T>
void pick(T* value) {
}

void run() {
  int n = 0;
  int* p = &n;
  pick(p);
}
