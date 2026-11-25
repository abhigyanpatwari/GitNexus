package com.example;
import jakarta.annotation.Resource;
public class ConcreteFactoryResourceConsumer {
  @Resource(name = "concreteGateway") Gateway gateway;
}
