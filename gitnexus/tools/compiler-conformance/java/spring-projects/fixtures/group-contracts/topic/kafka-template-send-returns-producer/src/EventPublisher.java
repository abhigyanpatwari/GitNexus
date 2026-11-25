public class EventPublisher {
    @Autowired KafkaTemplate<String, String> template;
    public void publish() {
        kafkaTemplate.send("user.created", payload);
    }
}