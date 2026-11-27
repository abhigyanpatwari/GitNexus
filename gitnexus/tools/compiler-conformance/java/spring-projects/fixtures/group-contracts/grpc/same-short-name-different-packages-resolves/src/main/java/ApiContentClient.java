package my.app.api;

import io.grpc.ManagedChannel;
import cn.unipus.ucf.api.proto.client.service.ContentRpcServiceGrpc;

public class ApiContentClient {
    private final ContentRpcServiceGrpc.ContentRpcServiceBlockingStub stub;
    public ApiContentClient(ManagedChannel ch) {
        this.stub = ContentRpcServiceGrpc.newBlockingStub(ch);
    }
}