@protocol Runnable
- (void)execute;
@end
@interface Worker <Runnable>
- (void)execute;
@end
@interface Child : Worker
- (void)execute;
@end
@implementation Worker
- (void)execute {}
- (void)dispatch:(id<Runnable>)worker { [worker execute]; }
@end
@implementation Child
- (void)execute { [super execute]; [self execute]; }
@end
@interface Other
- (void)run;
@end
// run remains a comment.
