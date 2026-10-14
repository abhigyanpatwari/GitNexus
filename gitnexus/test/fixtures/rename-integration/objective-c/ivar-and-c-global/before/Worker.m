static int counter = 7;
@interface Worker {
@public
  int counter;
}
@end
@implementation Worker
+ (int)readGlobal { return counter; }
- (int)read { return counter; }
- (int)readOther:(Worker *)other { return other->counter; }
- (int)shadow:(int)counter { return counter; }
@end
int outside(void) { return counter; }
