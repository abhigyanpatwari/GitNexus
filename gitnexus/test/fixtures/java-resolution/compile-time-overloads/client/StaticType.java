package client; import static names.Names.Long;
class StaticType {
 void select(Long value) {} void select(Number value) {}
 void staticTypeImport() { select(1L); }
 void staticSourceType(Long value) { select(value); }
}