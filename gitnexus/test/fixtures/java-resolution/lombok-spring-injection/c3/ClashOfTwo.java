package c3;
import lombok.AllArgsConstructor;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Autowired;
@org.springframework.stereotype.Service @RequiredArgsConstructor @AllArgsConstructor public class ClashOfTwo {
  final Clock3 clock;
  Audit3 audit;
  @Autowired ClashOfTwo(Clock3 chosen) { this.clock = chosen; }
}