#import <Foundation/Foundation.h>

int SYModuleSupportAdd(int a, int b);

@protocol SYModuleRunnable <NSObject>
- (void)runTask:(NSString *)name completion:(void (^)(BOOL ok))completion;
@end

@interface SYBaseCaller : NSObject
- (void)loadData:(NSString *)name completion:(void (^)(BOOL ok))completion;
@end

@interface SYModuleCaller : SYBaseCaller <SYModuleRunnable> {
  SYBaseCaller *_base;
}
@property (nonatomic, strong) SYBaseCaller *helper;
+ (instancetype)sharedCaller;
- (void)runTask:(NSString *)name completion:(void (^)(BOOL ok))completion;
@end

@interface SYModuleCaller (Tracing)
- (void)traceEvent:(NSString *)name;
@end
