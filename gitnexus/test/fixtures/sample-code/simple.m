#import <Foundation/Foundation.h>
@interface Calculator : NSObject
@property (nonatomic, strong) NSString *name;
- (void)reset;
- (NSInteger)add:(NSInteger)a to:(NSInteger)b;
- (NSInteger)multiply:(NSInteger)a with:(NSInteger)b;
+ (instancetype)sharedCalculator;
@end

@implementation Calculator
- (void)reset {
    NSLog(@"reset");
}

- (NSInteger)add:(NSInteger)a to:(NSInteger)b {
    return a + b;
}

- (NSInteger)multiply:(NSInteger)a with:(NSInteger)b {
    return a * b;
}

+ (instancetype)sharedCalculator {
    Calculator *calc = [Calculator alloc];
    return [calc init];
}
@end

void runCalculatorSample(void) {
    Calculator *calc = [Calculator sharedCalculator];
    [calc reset];
    [calc add:5 to:3];
    [calc multiply:2 with:4];
}
