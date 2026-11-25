@KafkaListener(topics = "user.created")
public void handleUserCreated(ConsumerRecord<String, String> record) {}