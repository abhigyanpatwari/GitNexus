
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@FeignClient(name = "order-service", path = "/feign-path")
@RequestMapping("/rm-path")
interface PrecedenceClient {
  @GetMapping("/orders")
  OrderDto getOrders();
}
