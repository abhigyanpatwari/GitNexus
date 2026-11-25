package c1;
import lombok.AllArgsConstructor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
@org.springframework.stereotype.Service @AllArgsConstructor public class ClashAutowired {
  Store1 store;
  @Autowired ClashAutowired(@Qualifier("primary") Store1 chosen) {}
}