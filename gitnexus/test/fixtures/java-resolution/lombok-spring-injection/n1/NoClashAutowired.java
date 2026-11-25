package n1;
import lombok.AllArgsConstructor;
import org.springframework.beans.factory.annotation.Autowired;
@org.springframework.stereotype.Service @AllArgsConstructor public class NoClashAutowired {
  Clock5 clock;
  @Autowired NoClashAutowired(Clock5 chosen, Audit5 audit) {}
}