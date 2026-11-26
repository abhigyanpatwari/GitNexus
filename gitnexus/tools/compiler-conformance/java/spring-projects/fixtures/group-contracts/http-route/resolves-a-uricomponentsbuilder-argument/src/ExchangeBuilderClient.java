
import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

class ExchangeBuilderClient {
  void run(RestTemplate restTemplate) {
    restTemplate.exchange(
        UriComponentsBuilder.fromPath("/api").path("/exchange-users").build().toUriString(),
        HttpMethod.PUT, null, String.class);
  }
}
