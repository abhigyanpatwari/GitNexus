class Point {
  int px = 0;
}

void configure({int x = 0}) {}

void make(Point p) {
  configure(x: 1);
  p.px = 2;
}
