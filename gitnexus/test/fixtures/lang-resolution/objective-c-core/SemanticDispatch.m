#import "SemanticProtocols.h"

@interface Worker : NSObject
- (void)work;
- (void)declaredOnlyWork;
+ (void)work;
@end

@implementation Worker
- (void)work {}
+ (void)work {}
@end

@interface SemanticDispatch : NSObject
- (void)runWithWorker:(Worker *)worker required:(id<RequiredWorker>)required optional:(id<OptionalWorker>)optional;
- (void)runWithClass:(Class<ClassWorker>)workerClass dynamic:(id)dynamic ambiguous:(id<FirstDuplicateWorker, SecondDuplicateWorker>)ambiguous;
- (void)runProtocolContracts:(id<InheritedWorker>)inherited
                  equivalent:(id<FirstDuplicateWorker, SecondDuplicateWorker>)equivalent
                 conflicting:(id<FirstConflictingWorker, SecondConflictingWorker>)conflicting;
- (void)runClassMessage;
- (void)runWithShadow:(Worker *)Worker;
@end

@implementation SemanticDispatch
- (void)runWithWorker:(Worker *)worker required:(id<RequiredWorker>)required optional:(id<OptionalWorker>)optional {
  [worker work];
  [worker declaredOnlyWork];
  [required requiredWork];
  [optional optionalWork];
}

- (void)runWithClass:(Class<ClassWorker>)workerClass dynamic:(id)dynamic ambiguous:(id<FirstDuplicateWorker, SecondDuplicateWorker>)ambiguous {
  [workerClass classWork];
  [dynamic work];
  [ambiguous duplicateWork];
}

- (void)runProtocolContracts:(id<InheritedWorker>)inherited
                  equivalent:(id<FirstDuplicateWorker, SecondDuplicateWorker>)equivalent
                 conflicting:(id<FirstConflictingWorker, SecondConflictingWorker>)conflicting {
  [inherited inheritedWork];
  [equivalent duplicateWork];
  [conflicting conflictingWork];
}

- (void)runClassMessage {
  [Worker work];
}

- (void)runWithShadow:(Worker *)Worker {
  [Worker work];
}
@end

@interface OverrideBase : NSObject
- (void)overrideWork;
@end

@implementation OverrideBase
- (void)overrideWork {}
@end

@interface OverrideChild : OverrideBase
- (void)overrideWork;
@end

@implementation OverrideChild
- (void)overrideWork {}
@end

@interface ProtocolQualifiedWorker : NSObject
@end

@implementation ProtocolQualifiedWorker
@end

@interface TypedDispatchCaller : NSObject
- (void)runWithOverride:(OverrideChild *)overrideChild
                 header:(HeaderOnlyWorker *)headerOnly
              qualified:(ProtocolQualifiedWorker<QualifiedWorkerContract> *)qualified;
@end

@implementation TypedDispatchCaller
- (void)runWithOverride:(OverrideChild *)overrideChild
                 header:(HeaderOnlyWorker *)headerOnly
              qualified:(ProtocolQualifiedWorker<QualifiedWorkerContract> *)qualified {
  [overrideChild overrideWork];
  [headerOnly headerWork];
  [qualified protocolOnly];
}
@end

@interface BaseDispatch : NSObject
- (void)baseWork;
@end

@implementation BaseDispatch
- (void)baseWork {}
@end

@interface ChildDispatch : BaseDispatch
- (void)run;
@end

@implementation ChildDispatch
- (void)run {
  [super baseWork];
}
@end

@interface RelatedDispatch : NSObject
+ (instancetype _Nullable)make;
- (instancetype _Nullable)makeSibling;
- (void)finish;
@end

@implementation RelatedDispatch
+ (instancetype _Nullable)make { return nil; }
- (instancetype _Nullable)makeSibling { return self; }
- (void)finish {}
@end

@interface RelatedResultCaller : NSObject
- (void)run;
- (void)runWithRelated:(RelatedDispatch *)related;
@end

@implementation RelatedResultCaller
- (void)run {
  [[RelatedDispatch make] finish];
}

- (void)runWithRelated:(RelatedDispatch *)related {
  [[related makeSibling] finish];
}
@end

@interface ChainFactory : NSObject
+ (id _Nullable)alloc;
- (id _Nullable)init;
- (id _Nullable)_initSpecial;
+ (id _Nullable)new;
- (id _Nullable)self;
- (id _Nullable)copy;
- (id _Nullable)mutableCopy;
- (void)finish;
@end

@implementation ChainFactory
+ (id _Nullable)alloc { return nil; }
- (id _Nullable)init { return self; }
- (id _Nullable)_initSpecial { return self; }
+ (id _Nullable)new { return nil; }
- (id _Nullable)self { return self; }
- (id _Nullable)copy { return self; }
- (id _Nullable)mutableCopy { return self; }
- (void)finish {}
@end

@interface ChainCaller : NSObject
- (void)runChain;
- (void)runUnderscoredInitChain;
- (void)runNewChain;
- (void)runSelfChain;
- (void)runCopyChain;
- (void)runMutableCopyChain;
@end

@implementation ChainCaller
- (void)runChain {
  [[[ChainFactory alloc] init] finish];
}

- (void)runUnderscoredInitChain {
  [[[ChainFactory alloc] _initSpecial] finish];
}

- (void)runNewChain {
  [[ChainFactory new] finish];
}

- (void)runSelfChain {
  [[[ChainFactory alloc] self] finish];
}

- (void)runCopyChain {
  [[[ChainFactory alloc] copy] finish];
}

- (void)runMutableCopyChain {
  [[[ChainFactory alloc] mutableCopy] finish];
}
@end

@interface ChainSignGuard : NSObject
+ (instancetype)make;
- (void)finish;
@end

@implementation ChainSignGuard
+ (instancetype)make { return nil; }
- (void)finish {}
@end

@interface ChainSignCaller : NSObject
- (void)runWithGuard:(ChainSignGuard *)guard;
@end

@implementation ChainSignCaller
- (void)runWithGuard:(ChainSignGuard *)guard {
  [[guard make] finish];
}
@end

@interface Product : NSObject
- (void)finish;
@end

@implementation Product
- (void)finish {}
@end

@interface ConcreteProtocolFactory : NSObject
@end

@implementation ConcreteProtocolFactory
@end

@interface ProtocolChainCaller : NSObject
- (void)runWithFactory:(id<ProductFactory>)factory;
- (void)runWithCompositeFactory:(id<ProductFactory, ProductMarker>)factory;
- (void)runWithConcreteFactory:(ConcreteProtocolFactory<ProductFactory> *)factory;
- (void)runWithFluentFactory:(id<FluentProductFactory>)factory;
@end

@implementation ProtocolChainCaller
- (void)runWithFactory:(id<ProductFactory>)factory {
  [[factory product] finish];
}

- (void)runWithCompositeFactory:(id<ProductFactory, ProductMarker>)factory {
  [[factory product] finish];
}

- (void)runWithConcreteFactory:(ConcreteProtocolFactory<ProductFactory> *)factory {
  [[factory product] finish];
}

- (void)runWithFluentFactory:(id<FluentProductFactory>)factory {
  [[[factory next] product] finish];
}
@end

@interface EmptySelectorTarget : NSObject
- (void)foo:(id)first :(id)second;
- (void):(id)first :(id)second;
@end

@implementation EmptySelectorTarget
- (void)foo:(id)first :(id)second {}
- (void):(id)first :(id)second {}
@end

@interface EmptySelectorCaller : NSObject
- (void)runWithTarget:(EmptySelectorTarget *)target;
@end

@implementation EmptySelectorCaller
- (void)runWithTarget:(EmptySelectorTarget *)target {
  [target foo:nil :nil];
  [target :nil :nil];
}
@end

@interface UnrelatedFactory : NSObject
+ (Product *)allocProduct;
- (void)finish;
@end

@implementation UnrelatedFactory
+ (Product *)allocProduct { return nil; }
- (void)finish {}
@end

@interface UnrelatedFactoryCaller : NSObject
- (void)run;
@end

@implementation UnrelatedFactoryCaller
- (void)run {
  [[UnrelatedFactory allocProduct] finish];
}
@end

@interface OnlyInstanceClassReceiver : NSObject
- (void)onlyInstance;
@end

@implementation OnlyInstanceClassReceiver
- (void)onlyInstance {}
@end

@interface OnlyInstanceClassCaller : NSObject
- (void)run;
@end

@implementation OnlyInstanceClassCaller
- (void)run {
  [OnlyInstanceClassReceiver onlyInstance];
}
@end

@interface ExternalSDKType (AppCategory)
- (void)appCategoryWork;
@end

@implementation ExternalSDKType (AppCategory)
- (void)appCategoryWork {}
@end

@interface ExternalCategoryCaller : NSObject
- (void)runWithExternal:(ExternalSDKType *)value;
@end

@implementation ExternalCategoryCaller
- (void)runWithExternal:(ExternalSDKType *)value {
  [value appCategoryWork];
}
@end

@interface BinaryCategoryBase : NSObject
@end

@implementation BinaryCategoryBase
@end

@interface BinaryCategoryBase (BinaryCategory)
- (void)binaryCategoryWork;
+ (Product *)binaryCategoryProduct;
@end

@interface BinaryCategoryCaller : NSObject
- (void)runWithBinary:(BinaryCategoryBase *)value;
- (void)runBinaryCategoryChain;
@end

@implementation BinaryCategoryCaller
- (void)runWithBinary:(BinaryCategoryBase *)value {
  [value binaryCategoryWork];
}

- (void)runBinaryCategoryChain {
  [[BinaryCategoryBase binaryCategoryProduct] finish];
}
@end

@interface TypedSubscriptBox : NSObject
- (id)objectAtIndexedSubscript:(NSUInteger)index;
@end

@implementation TypedSubscriptBox
- (id)objectAtIndexedSubscript:(NSUInteger)index { return nil; }
@end

@interface TypedSubscriptCaller : NSObject
- (void)runWithBox:(TypedSubscriptBox *)box;
@end

@implementation TypedSubscriptCaller
- (void)runWithBox:(TypedSubscriptBox *)box {
  id value = box[0];
}
@end

@interface ProtocolContractEdgeCases : NSObject
- (void)runWhitespace:(id<FirstWhitespaceWorker, SecondWhitespaceWorker>)value;
- (void)runRequirement:(id<OptionalRequirementWorker, RequiredRequirementWorker>)value;
- (void)runParameterWhitespace:(id<FirstParameterWhitespaceWorker, SecondParameterWhitespaceWorker>)value;
- (void)runAllOptional:(id<FirstAllOptionalWorker, SecondAllOptionalWorker>)value;
- (void)runPointerDepth:(id<FirstPointerDepthWorker, SecondPointerDepthWorker>)value;
- (void)runInheritedRequirement:(id<OptionalRedeclaringWorker>)value;
- (void)runInheritedConflict:(id<CombinedInheritedConflictWorker>)value;
- (void)runInheritedOverride:(id<CombinedInheritedOverrideWorker>)value;
- (void)runDiamondConflict:(id<DiamondConflictCombinedWorker>)value;
- (void)runUnknownProtocol:(id<RequiredWorker, MissingProtocolWorker>)value;
- (void)runUnknownInheritedProtocol:(id<IncompleteChildWorker>)value;
- (void)runAppOwnedProtocol:(id<AppOwnedWorker>)value;
@end

@implementation ProtocolContractEdgeCases
- (void)runWhitespace:(id<FirstWhitespaceWorker, SecondWhitespaceWorker>)value {
  [value whitespaceTitle];
}

- (void)runRequirement:(id<OptionalRequirementWorker, RequiredRequirementWorker>)value {
  [value requirementTitle];
}

- (void)runParameterWhitespace:(id<FirstParameterWhitespaceWorker, SecondParameterWhitespaceWorker>)value {
  [value consumeTitle:nil];
}

- (void)runAllOptional:(id<FirstAllOptionalWorker, SecondAllOptionalWorker>)value {
  [value allOptionalTitle];
}

- (void)runPointerDepth:(id<FirstPointerDepthWorker, SecondPointerDepthWorker>)value {
  [value pointerDepthTitle];
}

- (void)runInheritedRequirement:(id<OptionalRedeclaringWorker>)value {
  [value inheritedRequirementTitle];
}

- (void)runInheritedConflict:(id<CombinedInheritedConflictWorker>)value {
  [value branchConflict];
}

- (void)runInheritedOverride:(id<CombinedInheritedOverrideWorker>)value {
  [value branchConflict];
}

- (void)runDiamondConflict:(id<DiamondConflictCombinedWorker>)value {
  [value diamondConflictTitle];
}

- (void)runUnknownProtocol:(id<RequiredWorker, MissingProtocolWorker>)value {
  [value requiredWork];
}

- (void)runUnknownInheritedProtocol:(id<IncompleteChildWorker>)value {
  [value inheritedUnknownWork];
}

- (void)runAppOwnedProtocol:(id<AppOwnedWorker>)value {
  [value appOwnedWork];
}
@end

@interface SelfChainDispatch : NSObject
+ (instancetype)make;
- (instancetype)makeSibling;
- (void)finish;
+ (void)runClassSelfChain;
- (void)runInstanceSelfChain;
@end

@implementation SelfChainDispatch
+ (instancetype)make { return nil; }
- (instancetype)makeSibling { return self; }
- (void)finish {}

+ (void)runClassSelfChain {
  [[self make] finish];
}

- (void)runInstanceSelfChain {
  [[self makeSibling] finish];
}
@end

@interface CategoryBase : NSObject
- (void)categoryBaseWork;
- (instancetype)categoryFactory;
@end

@implementation CategoryBase
- (void)categoryBaseWork {}
- (instancetype)categoryFactory { return self; }
@end

@interface CategoryChild : CategoryBase
- (void)categoryFinish;
@end

@implementation CategoryChild
- (void)categoryFinish {}
@end

@interface CategoryChild (Review)
- (void)runCategory;
- (void)runNestedCategory;
@end

@implementation CategoryChild (Review)
- (void)runCategory {
  [super categoryBaseWork];
}

- (void)runNestedCategory {
  [[super categoryFactory] categoryFinish];
}
@end

@interface MissingSuperBase : NSObject
@end

@implementation MissingSuperBase
@end

@interface MissingSuperChild : MissingSuperBase
- (void)childOnly;
- (void)runMissingSuper;
@end

@implementation MissingSuperChild
- (void)childOnly {}

- (void)runMissingSuper {
  [super childOnly];
}
@end

@interface NestedSuperBase : NSObject
- (instancetype)init;
+ (instancetype)make;
@end

@implementation NestedSuperBase
- (instancetype)init { return self; }
+ (instancetype)make { return nil; }
@end

@interface NestedSuperChild : NestedSuperBase
- (void)finish;
- (void)runNestedSuper;
+ (void)runNestedClassSuper;
@end

@implementation NestedSuperChild
- (void)finish {}

- (void)runNestedSuper {
  [[super init] finish];
}

+ (void)runNestedClassSuper {
  [[super make] finish];
}
@end
