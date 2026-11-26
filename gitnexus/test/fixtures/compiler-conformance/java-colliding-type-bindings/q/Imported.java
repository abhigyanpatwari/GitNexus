package q;
import p.*;
class Imported implements Handler {
    public void handle() {}
    void request() { new Api.Request.Builder(); }
}
