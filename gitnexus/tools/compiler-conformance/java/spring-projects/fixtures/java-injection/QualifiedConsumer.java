package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class QualifiedConsumer {
  public QualifiedConsumer(@Qualifier("slowGateway") PaymentGateway gateway) {}
}
