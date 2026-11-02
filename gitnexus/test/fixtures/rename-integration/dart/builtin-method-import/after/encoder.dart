class Encoder {
  int import(int value) => value + 1;
}
int run(Encoder encoder) => encoder.import(3);
String label = 'encode';
// encode stays in this comment.
