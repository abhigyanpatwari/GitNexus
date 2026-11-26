package com.example;
import org.springframework.stereotype.Service;
@Service
public class ConstructorConsumer {
  public ConstructorConsumer(PaymentGateway gateway, ConcreteRepo repo) {}
}
