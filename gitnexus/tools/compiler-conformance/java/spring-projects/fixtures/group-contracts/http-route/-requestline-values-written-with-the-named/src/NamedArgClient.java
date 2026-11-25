
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "named-arg-service")
interface NamedArgClient {
  @RequestLine(value = "POST /create")
  String create();
}
