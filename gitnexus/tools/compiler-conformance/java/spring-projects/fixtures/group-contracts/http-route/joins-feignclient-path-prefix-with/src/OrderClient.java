
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "order-service", path = "/api")
interface OrderClient {
  @RequestLine("GET /orders/{id}")
  OrderDto get(Long id);

  @RequestLine("DELETE /orders/{id}")
  void delete(Long id);
}
