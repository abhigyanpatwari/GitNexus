
import org.springframework.web.client.RestTemplate;
import org.springframework.web.util.UriComponentsBuilder;

class PathClient {
  void run(RestTemplate restTemplate) {
    restTemplate.getForObject(UriComponentsBuilder.fromPath("/api").path("noslash").build().toUriString(), String.class);
    restTemplate.getForObject(UriComponentsBuilder.fromPath("/svc").path("/withslash").build().toUriString(), String.class);
    restTemplate.getForObject(UriComponentsBuilder.fromPath("/trail/").path("/seg").build().toUriString(), String.class);
    restTemplate.getForObject(UriComponentsBuilder.fromPath("/first-").path("value/").path("/end").build().toUriString(), String.class);
    restTemplate.getForObject(UriComponentsBuilder.fromHttpUrl("https://example.com/api").path("/ext").build().toUriString(), String.class);
    restTemplate.getForObject(UriComponentsBuilder.fromPath("/empty").path("").build().toUriString(), String.class);
  }
}
