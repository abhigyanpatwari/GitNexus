package com.example;
import jakarta.annotation.Resource;
public class ExplicitResourceConsumer {
  @Resource(name = "slowGateway") Gateway selected;
}
