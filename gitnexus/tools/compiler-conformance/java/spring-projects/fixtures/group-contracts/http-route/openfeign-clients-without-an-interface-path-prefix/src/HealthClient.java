
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

@FeignClient(name = "health-service")
interface HealthClient {
  @GetMapping("/health")
  String health();
}
