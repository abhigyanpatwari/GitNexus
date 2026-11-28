export class Token { outer() { return 1; } }
switch (Number('1')) {
  case 1:
    class Token { inner() { return 2; } }
    new Token().inner();
}
new Token().outer();
