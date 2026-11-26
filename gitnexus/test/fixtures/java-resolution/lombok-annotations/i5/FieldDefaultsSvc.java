package i5;
import lombok.AccessLevel; import lombok.AllArgsConstructor; import lombok.experimental.FieldDefaults;
@org.springframework.stereotype.Service @AllArgsConstructor
@FieldDefaults(makeFinal = true, level = AccessLevel.PRIVATE)
public class FieldDefaultsSvc { Helper helper; Audit audit = new Audit(); }