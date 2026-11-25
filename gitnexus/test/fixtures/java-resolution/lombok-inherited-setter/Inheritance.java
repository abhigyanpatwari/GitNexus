import lombok.Data;
@Data class GeneratedBase { private String value; }
class GeneratedChild extends GeneratedBase { public void setValue(Object value) {} }
class Consumer { void choose(GeneratedChild target) { target.setValue("x"); } }
