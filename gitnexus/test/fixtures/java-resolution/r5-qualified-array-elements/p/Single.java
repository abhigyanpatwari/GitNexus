package p;
class SingleBase { static class Outer { static class Inner { void save() {} } } }
class Single extends SingleBase { void run(Outer.Inner[] values) { values[0].save(); } }