package com.example;
import jakarta.annotation.Resource;
public class TypeOverrideResourceConsumer {
  @Resource(type = ConcreteRepo.class) Object repo;
}
