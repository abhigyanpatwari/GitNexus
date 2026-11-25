package p;
class FieldInit { int first = items()[0].id(); User[] items() { return null; } }
class BlockInit { { items()[0].save(); } User[] items() { return null; } }
class LambdaFieldInit { Runnable action = () -> items()[0].save(); User[] items() { return null; } }
enum EnumInit { A; int first = items()[0].id(); { items()[0].save(); } User[] items() { return null; } }
class StaticFieldInit { static int first = items()[0].id(); User[] items() { return null; } }
class StaticBlockInit { static { items()[0].save(); } User[] items() { return null; } }
interface ConstantInit { int FIRST = items()[0].id(); default User[] items() { return null; } }