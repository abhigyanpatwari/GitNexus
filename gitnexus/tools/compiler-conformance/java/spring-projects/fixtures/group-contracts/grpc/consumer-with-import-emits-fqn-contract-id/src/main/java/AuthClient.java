package my.app;

import io.grpc.ManagedChannel;
import com.acme.auth.proto.AuthServiceGrpc;

public class AuthClient {
    private final AuthServiceGrpc.AuthServiceBlockingStub stub;
    public AuthClient(ManagedChannel ch) {
        this.stub = AuthServiceGrpc.newBlockingStub(ch);
    }
}