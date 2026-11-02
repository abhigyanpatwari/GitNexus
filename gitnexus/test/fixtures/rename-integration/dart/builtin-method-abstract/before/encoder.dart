class Encoder {
  int encode(int value) => value + 1;
}
int run(Encoder encoder) => encoder.encode(3);
String label = 'encode';
// encode stays in this comment.
