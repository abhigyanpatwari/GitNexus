
import okhttp3.Request;
import okhttp3.RequestBody;

class OkClient {
  void run(RequestBody body) {
    new Request.Builder().url("/api/things").post(body).build();
  }
}
