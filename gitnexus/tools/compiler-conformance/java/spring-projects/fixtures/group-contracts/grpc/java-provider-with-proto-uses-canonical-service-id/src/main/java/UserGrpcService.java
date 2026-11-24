@GrpcService
public class UserGrpcService extends UserServiceGrpc.UserServiceImplBase {
    @Override
    public void getUser(GetUserRequest req, StreamObserver<GetUserResponse> obs) {}
}