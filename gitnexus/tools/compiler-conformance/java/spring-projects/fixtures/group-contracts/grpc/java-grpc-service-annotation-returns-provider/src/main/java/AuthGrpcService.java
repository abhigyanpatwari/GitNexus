@GrpcService
public class AuthGrpcService extends AuthServiceGrpc.AuthServiceImplBase {
    @Override
    public void login(LoginRequest req, StreamObserver<LoginResponse> obs) {}
}