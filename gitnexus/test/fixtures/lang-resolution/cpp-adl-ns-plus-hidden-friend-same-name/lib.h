namespace lib {

struct T {
  // Hidden friend: a namespace-scope member of `lib` visible ONLY via ADL.
  // Exercises the friendCandidates bucket.
  friend void combine(T& a, T& b) {}
};

// Ordinary namespace-level callable. Exercises the nsCandidates bucket.
void process(T& x) {}

}
