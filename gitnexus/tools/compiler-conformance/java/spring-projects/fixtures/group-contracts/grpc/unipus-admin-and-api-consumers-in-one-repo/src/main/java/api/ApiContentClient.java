package my.app.api;

import io.grpc.ManagedChannel;
import cn.unipus.ucf.api.proto.client.service.ContentRpcServiceGrpc;

public class ApiContentClient {
    public ApiContentClient(ManagedChannel ch) {
        ContentRpcServiceGrpc.newBlockingStub(ch);
    }
}