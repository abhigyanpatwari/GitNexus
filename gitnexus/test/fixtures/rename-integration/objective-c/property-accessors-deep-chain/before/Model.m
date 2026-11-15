@interface Leaf
@property int value;
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
@synthesize value = _value;
- (int)value { return _value; }
- (void)setValue:(int)value { _value = value; }
- (void)copy:(Root *)root other:(Other *)other { self.value = root.branch.leaf.value; other.value = 9; [self setValue:3]; }
@end
