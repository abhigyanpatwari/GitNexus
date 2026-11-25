package com.example;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
public class QualifierConsumer {
  @Autowired @Qualifier("gatewayAlias") Gateway gateway;
}
