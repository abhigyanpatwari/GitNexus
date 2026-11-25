
import java.net.URI;
import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;

class UriClient {
  void run(RestTemplate restTemplate) {
    String dynamicPath = "/api/dynamic-users/99";
    restTemplate.getForEntity(URI.create("/api/uri-users/42"), String.class);
    restTemplate.exchange(URI.create("/api/uri-users/42/details"), HttpMethod.POST, null, String.class);
    restTemplate.getForObject(dynamicPath, String.class);
  }
}
