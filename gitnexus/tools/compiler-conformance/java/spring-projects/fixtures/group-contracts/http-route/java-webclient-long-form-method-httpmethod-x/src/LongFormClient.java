
import org.springframework.http.HttpMethod;
import org.springframework.web.reactive.function.client.WebClient;

class LongFormClient {
  void run(WebClient webClient) {
    webClient.method(HttpMethod.GET).uri("/api/get").retrieve();
    webClient.method(HttpMethod.POST).uri("/api/post").retrieve();
    webClient.method(HttpMethod.PUT).uri("/api/put").retrieve();
    webClient.method(HttpMethod.DELETE).uri("/api/delete").retrieve();
    webClient.method(HttpMethod.PATCH).uri("/api/users/42").retrieve();
  }
}
