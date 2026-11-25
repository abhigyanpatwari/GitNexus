package com.example;
import jakarta.annotation.Resource;
public class MissingResourceConsumer {
  @Resource(name = "missing") Gateway gateway;
}
