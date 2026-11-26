package my.app.admin;

import io.grpc.ManagedChannel;
import cn.unipus.ucf.admin.proto.client.service.ContentRpcServiceGrpc;

public class AdminContentClient {
    public AdminContentClient(ManagedChannel ch) {
        ContentRpcServiceGrpc.newBlockingStub(ch);
    }
}