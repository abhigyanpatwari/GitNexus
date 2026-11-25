package c2;
import lombok.AllArgsConstructor;
import jakarta.inject.Inject;
@org.springframework.stereotype.Service @AllArgsConstructor public class ClashInject {
  Clock2 clock;
  @Inject ClashInject(Clock2 chosen) {}
}