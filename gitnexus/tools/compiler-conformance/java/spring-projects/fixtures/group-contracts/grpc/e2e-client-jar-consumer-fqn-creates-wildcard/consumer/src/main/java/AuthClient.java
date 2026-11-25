package my.app;

import io.grpc.ManagedChannel;
import com.acme.auth.proto.AuthServiceGrpc;

public class AuthClient {
    public AuthClient(ManagedChannel ch) {
        AuthServiceGrpc.newBlockingStub(ch).login(null);
    }
}