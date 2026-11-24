package my.server;

import com.acme.auth.proto.AuthServiceGrpc;
import io.grpc.stub.StreamObserver;

public class AuthServerImpl extends AuthServiceGrpc.AuthServiceImplBase {
    @Override
    public void login(LoginRequest req, StreamObserver<LoginResponse> obs) {}
}