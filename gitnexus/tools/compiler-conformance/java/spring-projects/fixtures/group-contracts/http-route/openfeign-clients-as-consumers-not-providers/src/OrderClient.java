
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PathVariable;

@FeignClient(name = "order-service", url = "${order.service.url}", path = "/api")
interface OrderClient {
  @GetMapping("/orders/{id}")
  OrderDto getOrder(@PathVariable("id") String id);

  @PostMapping(path = "/orders")
  OrderDto createOrder(OrderDto body);
}
