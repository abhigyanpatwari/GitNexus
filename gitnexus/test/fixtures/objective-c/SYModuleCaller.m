#import "SYModuleCaller.h"
#include "SYModuleSupport.h"
@import Foundation;

#define SY_OBJC_RECEIVER(x) x

@interface SYModuleCaller ()
@property (nonatomic, strong) SYBaseCaller *privateHelper;
@end

@implementation SYModuleCaller
+ (instancetype)sharedCaller { return [SYModuleCaller new]; }
- (void)runTask:(NSString *)name completion:(void (^)(BOOL ok))completion {
  SYBaseCaller *typed = self.helper;
  id dynamic = typed;
  [self traceEvent:name];
  [SY_OBJC_RECEIVER(self) traceEvent:name];
  [super loadData:name completion:completion];
  [self loadData:name completion:completion];
  [typed loadData:name completion:completion];
  [dynamic loadData:name completion:completion];
}
- (void)runProtocol:(id<SYModuleRunnable>)runner {
  [runner runTask:@"x" completion:^(BOOL ok) {}];
}
@end

@implementation SYModuleCaller (Tracing)
- (void)traceEvent:(NSString *)name {}
@end

static int SYModuleCompute(int value) { return value + 1; }
