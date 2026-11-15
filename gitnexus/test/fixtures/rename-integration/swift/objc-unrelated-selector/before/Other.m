@interface Other
- (void)notify:(int)count loudly:(int)flag;
@end

void use(Other *other) { [other notify:1 loudly:2]; }
