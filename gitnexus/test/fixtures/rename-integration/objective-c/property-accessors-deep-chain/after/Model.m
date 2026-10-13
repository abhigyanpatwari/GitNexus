@interface Leaf
@property int count;
@end
@interface Branch
@property Leaf *leaf;
@end
@interface Root
@property Branch *branch;
@end
@interface Other
@property int value;
@end
@implementation Leaf
@synthesize count = _count;
- (int)count { return _count; }
- (void)setCount:(int)value { _count = value; }
- (void)copy:(Root *)root other:(Other *)other { self.count = root.branch.leaf.count; other.value = 9; [self setCount:3]; }
@end
