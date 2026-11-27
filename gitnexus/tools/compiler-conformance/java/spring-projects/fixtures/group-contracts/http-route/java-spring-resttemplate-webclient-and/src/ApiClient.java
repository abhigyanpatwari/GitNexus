
import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import okhttp3.Request;

class ApiClient {
  void run(RestTemplate restTemplate, WebClient webClient) {
    restTemplate.getForObject("/api/users/{id}", String.class, 42);
    restTemplate.exchange("/api/users/{id}/details", HttpMethod.GET, null, String.class);
    webClient.post().uri("/api/users");
    new Request.Builder().url("/api/orders/42").build();
  }
}
