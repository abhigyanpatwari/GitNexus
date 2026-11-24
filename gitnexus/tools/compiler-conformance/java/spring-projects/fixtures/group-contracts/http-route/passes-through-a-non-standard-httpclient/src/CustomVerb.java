
import java.net.URI;
import java.net.http.HttpRequest;

class CustomVerb {
  void run(HttpRequest.BodyPublisher body) throws Exception {
    HttpRequest r = HttpRequest.newBuilder().uri(URI.create("/api/report")).method("REPORT", body).build();
  }
}
