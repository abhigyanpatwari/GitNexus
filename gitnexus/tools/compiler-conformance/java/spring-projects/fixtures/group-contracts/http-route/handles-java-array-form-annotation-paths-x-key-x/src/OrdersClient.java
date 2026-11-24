
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.PostMapping;

@FeignClient(name = "orders")
interface OrdersClient {
  @PostMapping({"/orders/search"})
  Object search();
}
