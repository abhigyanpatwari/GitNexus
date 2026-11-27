
import java.net.URI;
import java.net.http.HttpRequest;
import okhttp3.Request;
import okhttp3.RequestBody;

class TwoVerb {
  void run(RequestBody body, HttpRequest.BodyPublisher pub) throws Exception {
    HttpRequest hc = HttpRequest.newBuilder().GET().uri(URI.create("/api/hc-two")).POST(pub).build();
    new Request.Builder().get().url("/api/ok-two").post(body).build();
  }
}
