package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service
public class FieldConsumer {
  @Autowired private PaymentGateway gateway;
}
