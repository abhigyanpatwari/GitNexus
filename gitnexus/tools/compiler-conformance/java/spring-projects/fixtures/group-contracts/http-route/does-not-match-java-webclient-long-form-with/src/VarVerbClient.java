
import org.springframework.http.HttpMethod;
import org.springframework.web.reactive.function.client.WebClient;

class VarVerbClient {
  void run(WebClient webClient, HttpMethod verb) {
    webClient.method(verb).uri("/api/users/42").retrieve();
  }
}
