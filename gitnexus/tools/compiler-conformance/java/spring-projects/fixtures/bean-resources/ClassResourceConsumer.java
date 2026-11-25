package com.example;
import jakarta.annotation.Resource;
public class ClassResourceConsumer {
  @Resource(name = "classGateway") Gateway gateway;
}
