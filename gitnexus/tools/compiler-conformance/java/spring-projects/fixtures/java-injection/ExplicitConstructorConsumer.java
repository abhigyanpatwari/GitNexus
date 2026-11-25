package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service
public class ExplicitConstructorConsumer {
  public ExplicitConstructorConsumer() {}
  @Autowired public ExplicitConstructorConsumer(ConcreteRepo repo) {}
}
