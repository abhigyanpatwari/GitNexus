package com.example;
import jakarta.annotation.Resource;
public class RuntimeResourceConsumer {
  @Resource(lookup = "java:global/gateway") Gateway gateway;
}
