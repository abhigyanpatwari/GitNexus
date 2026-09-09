#import <Foundation/Foundation.h>

#define RCT_EXTERN_C_BEGIN
#define RCT_EXTERN_C_END

RCT_EXTERN_C_BEGIN
typedef struct SYModuleMethodInfo {
  const char *const name;
} SYModuleMethodInfo;
RCT_EXTERN_C_END

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
