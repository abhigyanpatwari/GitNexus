package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class DynamicQualifierConsumer {
  private static final String GATEWAY = "slowGateway";
  public DynamicQualifierConsumer(@Qualifier(GATEWAY) PaymentGateway gateway) {}
}
