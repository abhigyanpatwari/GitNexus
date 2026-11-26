
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "wrong-key-service")
interface WrongKeyClient {
  @RequestLine(name = "GET /should-not-extract")
  String shouldNotBeExtracted();
}
