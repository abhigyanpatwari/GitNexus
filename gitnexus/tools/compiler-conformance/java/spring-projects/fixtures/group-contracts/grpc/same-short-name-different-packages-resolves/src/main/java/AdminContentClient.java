package my.app.admin;

import io.grpc.ManagedChannel;
import cn.unipus.ucf.admin.proto.client.service.ContentRpcServiceGrpc;

public class AdminContentClient {
    private final ContentRpcServiceGrpc.ContentRpcServiceBlockingStub stub;
    public AdminContentClient(ManagedChannel ch) {
        this.stub = ContentRpcServiceGrpc.newBlockingStub(ch);
    }
}