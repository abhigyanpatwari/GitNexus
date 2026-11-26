
import org.springframework.cloud.openfeign.FeignClient;
import feign.RequestLine;

@FeignClient(name = "search-service")
interface SearchClient {
  @RequestLine("GET /search?q={query}&limit={limit}")
  SearchResult search();
}
