#import "BaseStore.h"

@protocol Storable
@optional
@property (nonatomic, readonly) NSString *protocolName;
- (void)optionalRun;
@required
- (void)run;
@end

@interface Store : BaseStore <Storable> {
  NSString *_token;
}
@property (nonatomic, readonly) NSString *name;
@property (nonatomic, getter=isReady) BOOL ready;
@property (nonatomic) NSString *runtimeValue;
@property (nonatomic) NSString *alias;
- (void)save:(id)value completion:(id)completion;
- (id)objectAtIndexedSubscript:(NSUInteger)index;
- (void)setObject:(id)value atIndexedSubscript:(NSUInteger)index;
- (void)run;
@end
