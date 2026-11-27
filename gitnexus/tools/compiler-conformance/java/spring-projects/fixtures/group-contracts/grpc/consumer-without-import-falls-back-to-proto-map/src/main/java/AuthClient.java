package my.app;

import io.grpc.ManagedChannel;

public class AuthClient {
    private final com.acme.auth.proto.AuthServiceGrpc.AuthServiceBlockingStub stub;
    public AuthClient(ManagedChannel ch) {
        this.stub = com.acme.auth.proto.AuthServiceGrpc.newBlockingStub(ch);
    }
}