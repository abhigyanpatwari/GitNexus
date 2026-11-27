
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

class BuilderClient {
  void run(RestTemplate restTemplate, String idVar) {
    restTemplate.getForObject(
        UriComponentsBuilder.fromPath("/api").path("/builder-users").pathSegment("42").build().toUriString(),
        String.class);
    restTemplate.getForObject(
        UriComponentsBuilder.fromUriString("/base").path("/sub").queryParam("page", "1").build().toUriString(),
        String.class);
    restTemplate.getForObject(
        UriComponentsBuilder.fromHttpUrl("https://example.com/api").path("/external-users").query("page=1").build().toUriString(),
        String.class);
    restTemplate.getForObject(
        UriComponentsBuilder.fromPath("/api").pathSegment(idVar).build().toUriString(),
        String.class);
  }
}
