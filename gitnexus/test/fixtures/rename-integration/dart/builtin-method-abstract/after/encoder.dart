class Encoder {
  int abstract(int value) => value + 1;
}
int run(Encoder encoder) => encoder.abstract(3);
String label = 'encode';
// encode stays in this comment.
