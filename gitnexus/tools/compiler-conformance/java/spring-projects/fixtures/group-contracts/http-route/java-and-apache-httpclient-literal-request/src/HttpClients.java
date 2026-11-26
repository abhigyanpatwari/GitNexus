
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.client.methods.HttpPut;
import org.apache.http.client.methods.HttpDelete;
import org.apache.http.client.methods.HttpPatch;

class HttpClients {
  void run(HttpClient client) throws Exception {
    HttpRequest get = HttpRequest.newBuilder()
        .uri(URI.create("/api/users/1"))
        .GET()
        .build();
    HttpRequest post = HttpRequest.newBuilder()
        .uri(URI.create("/api/users"))
        .POST(HttpRequest.BodyPublishers.ofString("{}"))
        .build();

    new HttpGet("/api/orders/2");
    new HttpPost("/api/orders");
    new HttpPut("/api/orders/3");
    new HttpDelete("/api/orders/4");
    new HttpPatch("/api/orders/5");
  }
}
