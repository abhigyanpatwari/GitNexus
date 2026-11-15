@protocol Runnable
- (void)run;
@end
@interface Worker <Runnable>
- (void)run;
@end
@interface Child : Worker
- (void)run;
@end
@implementation Worker
- (void)run {}
- (void)dispatch:(id<Runnable>)worker { [worker run]; }
@end
@implementation Child
- (void)run { [super run]; [self run]; }
@end
@interface Other
- (void)run;
@end
// run remains a comment.
