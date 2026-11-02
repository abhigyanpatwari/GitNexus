static int counter = 7;
@interface Worker {
@public
  int total;
}
@end
@implementation Worker
+ (int)readGlobal { return counter; }
- (int)read { return total; }
- (int)readOther:(Worker *)other { return other->total; }
- (int)shadow:(int)counter { return counter; }
@end
int outside(void) { return counter; }
