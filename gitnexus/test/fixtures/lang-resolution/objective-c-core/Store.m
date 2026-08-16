#import "Store.h"
#import "Legacy.h"

@interface Store ()
- (void)privateThing;
@end

@implementation Store
@dynamic runtimeValue;
@synthesize alias = _aliasStorage;

- (void)save:(id)value completion:(id)completion {
}

- (void)privateThing {
}

- (id)objectAtIndexedSubscript:(NSUInteger)index {
  return nil;
}

- (void)setObject:(id)value atIndexedSubscript:(NSUInteger)index {
}

- (void)run {
  void (^handler)(BOOL) = ^(BOOL ok) {
    [self privateThing];
  };
  handler(YES);
  LegacyTouch();
  [self setReady:YES];
  self.ready = self.ready;
  if ([self isReady]) {
    [self privateThing];
  }
  [self save:nil completion:nil];
  [self categoryOnly];
  id indexedValue = self[0];
  self[0] = indexedValue;
}
@end
