
import java.net.URI;
import java.net.http.HttpRequest;
import org.springframework.web.reactive.function.client.WebClient;

class CtorOverride {
  void run(WebClient webClient) {
    HttpRequest a = HttpRequest.newBuilder(URI.create("/api/ctor-overridden")).uri(URI.create("/api/override-wins")).build();
    webClient.get().uri(URI.create("/api/webclient-not-hc")).retrieve();
  }
}
