
import org.springframework.web.bind.annotation.GetMapping;

interface NotFeignClient {
  String MARKER = "@FeignClient";

  @GetMapping("/not-feign")
  String call();
}
