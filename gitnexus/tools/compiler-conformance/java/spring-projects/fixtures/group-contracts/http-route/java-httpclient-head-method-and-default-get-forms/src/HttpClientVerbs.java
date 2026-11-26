
import java.net.URI;
import java.net.http.HttpRequest;

class HttpClientVerbs {
  void run(String verb) throws Exception {
    HttpRequest head = HttpRequest.newBuilder().uri(URI.create("/api/users/head")).HEAD().build();
    HttpRequest patch = HttpRequest.newBuilder().uri(URI.create("/api/users/2")).method("PATCH", HttpRequest.BodyPublishers.ofString("{}")).build();
    HttpRequest def = HttpRequest.newBuilder().uri(URI.create("/api/default-users/3")).build();
    HttpRequest dyn = HttpRequest.newBuilder().uri(URI.create("/api/dyn/4")).method(verb, HttpRequest.BodyPublishers.noBody()).build();
  }
}
