class Point {
  int x = 0;
}

void configure({int x = 0}) {}

void make(Point p) {
  configure(x: 1);
  p.x = 2;
}
