
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@RequestMapping("/rm-path")
@FeignClient(name = "order-service", path = "/feign-path")
interface ReversedPrecedenceClient {
  @GetMapping("/orders")
  OrderDto getOrders();
}
