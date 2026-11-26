public class AuthClient {
    private final AuthServiceGrpc.AuthServiceBlockingStub stub;
    public AuthClient(ManagedChannel ch) {
        this.stub = AuthServiceGrpc.newBlockingStub(ch);
    }
}