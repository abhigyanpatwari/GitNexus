// F44: Class expression — should produce a Class scope for the expression body
// On main: no @scope.class emitted → methods have no Class parent
// On this branch: (class) @scope.class emitted → methods get Class scope
export const instance = class {
  greet(): string {
    return 'hello';
  }
};
