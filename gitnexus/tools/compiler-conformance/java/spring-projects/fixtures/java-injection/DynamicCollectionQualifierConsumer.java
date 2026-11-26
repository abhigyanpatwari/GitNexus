package com.example;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class DynamicCollectionQualifierConsumer {
  private static final String GATEWAY = "slowGateway";
  @Autowired @Qualifier(GATEWAY) private List<PaymentGateway> gateways;
}
