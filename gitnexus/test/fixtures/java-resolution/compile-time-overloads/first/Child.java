package first; class Child extends second.Middle {
 void access(Object value) {} void interruptedPackage() { access("x"); }
 void castBase() { ((Base)this).access("x"); }
}