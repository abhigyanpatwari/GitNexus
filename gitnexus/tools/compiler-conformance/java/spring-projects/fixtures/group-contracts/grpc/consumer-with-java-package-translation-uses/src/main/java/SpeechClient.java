package my.app;

import io.grpc.ManagedChannel;
import com.google.cloud.speech.v1.SpeechGrpc;

public class SpeechClient {
    public SpeechClient(ManagedChannel ch) {
        SpeechGrpc.newBlockingStub(ch).recognize(null);
    }
}