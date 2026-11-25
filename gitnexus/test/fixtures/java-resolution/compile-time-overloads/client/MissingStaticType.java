package client; import static external.Names.Long;
class MissingStaticType { void select(Long value) {} void select(Number value) {} void missingStaticType() { select(1L); } }