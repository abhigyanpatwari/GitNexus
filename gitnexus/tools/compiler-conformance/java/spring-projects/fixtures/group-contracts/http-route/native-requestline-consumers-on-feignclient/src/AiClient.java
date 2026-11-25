
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "ai-backend")
interface AiClient {
  @RequestLine("POST /ai/summarize")
  String summarize();

  @RequestLine("GET /ai/health")
  String health();
}
