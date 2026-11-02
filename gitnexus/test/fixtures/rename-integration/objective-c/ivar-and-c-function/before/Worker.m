static int compute(int value) { return value + 1; }
@interface Worker {
@public
  int compute;
}
@end
@implementation Worker
+ (int)callHelper { return compute(3); }
- (int)read { return compute; }
- (int)readOther:(Worker *)other { return other->compute; }
- (int)shadow:(int)compute { return compute; }
@end
int outside(void) { return compute(4); }
