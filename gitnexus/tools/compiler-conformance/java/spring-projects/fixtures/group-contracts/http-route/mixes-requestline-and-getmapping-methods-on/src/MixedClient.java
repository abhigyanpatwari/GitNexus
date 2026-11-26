
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import feign.RequestLine;

@FeignClient(name = "mixed-service", path = "/api")
interface MixedClient {
  @GetMapping("/spring-style")
  String springStyle();

  @RequestLine("GET /native-style")
  String nativeStyle();
}
