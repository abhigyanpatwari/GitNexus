package i2; import lombok.*;
@Data public class Dto implements java.io.Serializable { @Setter(AccessLevel.NONE) private String id; private String name; }