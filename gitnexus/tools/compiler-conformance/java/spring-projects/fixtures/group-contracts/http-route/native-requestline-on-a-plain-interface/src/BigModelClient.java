
import feign.Headers;
import feign.RequestLine;
import feign.Response;

public interface BigModelClient {
  @RequestLine("POST /ai/summarization")
  @Headers("Content-Type: application/json")
  Response summarize();

  @RequestLine("GET /ai/concurrent")
  Response concurrent();
}
