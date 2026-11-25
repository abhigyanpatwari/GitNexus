
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

@FeignClient(name = "users-service", path = "/api")
interface UsersClient {
  @GetMapping("/users")
  Object users();
}
