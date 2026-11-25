
import org.springframework.http.HttpMethod;
import org.springframework.web.reactive.function.client.WebClient;

class LongFormClient {
  void run(WebClient webClient) {
    webClient.method(HttpMethod.GET).uri("/api/items").retrieve();
  }
}
