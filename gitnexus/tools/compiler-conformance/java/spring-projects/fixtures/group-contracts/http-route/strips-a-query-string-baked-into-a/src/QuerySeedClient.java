
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

class QuerySeedClient {
  void run(RestTemplate restTemplate) {
    restTemplate.getForObject(
        UriComponentsBuilder.fromUriString("/base?x=1").path("/sub").build().toUriString(),
        String.class);
    restTemplate.getForObject(
        UriComponentsBuilder.fromHttpUrl("https://example.com/api?x=1").path("/y").build().toUriString(),
        String.class);
  }
}
