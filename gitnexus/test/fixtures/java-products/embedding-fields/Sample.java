class Sample {
 String before;
 Sample() { consume("BODY_SENTINEL"); }
 String run() { return "BODY_SENTINEL"; }
 int after = 42;
}
