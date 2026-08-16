@protocol RequiredWorker
- (void)requiredWork;
@end

@protocol OptionalWorker
@optional
- (void)optionalWork;
@end

@protocol ClassWorker
+ (void)classWork;
@end

@protocol FirstDuplicateWorker
- (void)duplicateWork;
@end

@protocol SecondDuplicateWorker
- (void)duplicateWork;
@end

@protocol InheritedWorkerBase
- (void)inheritedWork;
@end

@protocol InheritedWorker <InheritedWorkerBase>
@end

@protocol FirstConflictingWorker
- (NSString *)conflictingWork;
@end

@protocol SecondConflictingWorker
- (NSNumber *)conflictingWork;
@end

@protocol FirstWhitespaceWorker
- (NSString*)whitespaceTitle;
@end

@protocol SecondWhitespaceWorker
- (NSString *)whitespaceTitle;
@end

@protocol OptionalRequirementWorker
@optional
- (NSString *)requirementTitle;
@end

@protocol RequiredRequirementWorker
@required
- (NSString*)requirementTitle;
@end

@protocol FirstParameterWhitespaceWorker
- (void)consumeTitle:(NSString*)title;
@end

@protocol SecondParameterWhitespaceWorker
- (void)consumeTitle:(NSString *)title;
@end

@protocol FirstAllOptionalWorker
@optional
- (NSString *)allOptionalTitle;
@end

@protocol SecondAllOptionalWorker
@optional
- (NSString*)allOptionalTitle;
@end

@protocol FirstPointerDepthWorker
- (NSString *)pointerDepthTitle;
@end

@protocol SecondPointerDepthWorker
- (NSString **)pointerDepthTitle;
@end

@protocol RequiredAncestorWorker
@required
- (NSString *)inheritedRequirementTitle;
@end

@protocol OptionalRedeclaringWorker <RequiredAncestorWorker>
@optional
- (NSString*)inheritedRequirementTitle;
@end

@protocol KnownIncompleteParentWorker
- (void)inheritedUnknownWork;
@end

@protocol IncompleteChildWorker <KnownIncompleteParentWorker, MissingInheritedWorker>
@end

@protocol AppOwnedWorker <NSObject>
@optional
- (void)appOwnedWork;
@end

@class Product;

@protocol ProductFactory
- (Product *)product;
@end

@protocol ProductMarker
@end

@protocol FluentProductFactory <ProductFactory>
- (instancetype)next;
@end

@protocol LeftInheritedConflictWorker
- (NSString *)branchConflict;
@end

@protocol RightInheritedConflictWorker
- (NSNumber *)branchConflict;
@end

@protocol CombinedInheritedConflictWorker <LeftInheritedConflictWorker, RightInheritedConflictWorker>
@end

@protocol CombinedInheritedOverrideWorker <LeftInheritedConflictWorker, RightInheritedConflictWorker>
- (NSString *)branchConflict;
@end

@protocol DiamondConflictBaseWorker
- (NSString *)diamondConflictTitle;
@end

@protocol DiamondConflictLeftWorker <DiamondConflictBaseWorker>
- (NSNumber *)diamondConflictTitle;
@end

@protocol DiamondConflictRightWorker <DiamondConflictBaseWorker>
@end

@protocol DiamondConflictCombinedWorker <DiamondConflictLeftWorker, DiamondConflictRightWorker>
@end

@protocol QualifiedWorkerContract
- (void)protocolOnly;
@end

@class HeaderOnlyWorker;

@interface HeaderOnlyWorker : NSObject
- (void)headerWork;
@end
