package example;

public class Worker {
    public Worker() {
        SpringContextUtil.getBeans(Handler.class);
    }
}
