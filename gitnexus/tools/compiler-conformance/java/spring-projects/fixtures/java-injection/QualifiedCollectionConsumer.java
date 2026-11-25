package com.example;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class QualifiedCollectionConsumer {
  @Autowired @Qualifier("slowGateway") private List<PaymentGateway> gateways;
}
