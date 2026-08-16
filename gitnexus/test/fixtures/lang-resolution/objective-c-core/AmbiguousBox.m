@interface AmbiguousBox : NSObject
- (id)objectAtIndexedSubscript:(NSUInteger)index;
- (id)objectForKeyedSubscript:(id)key;
- (void)run;
@end

@implementation AmbiguousBox
- (id)objectAtIndexedSubscript:(NSUInteger)index {
  return nil;
}

- (id)objectForKeyedSubscript:(id)key {
  return nil;
}

- (void)run {
  id value = self[0];
}
@end
