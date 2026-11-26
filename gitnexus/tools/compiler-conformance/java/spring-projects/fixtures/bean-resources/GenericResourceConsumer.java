package com.example;
import java.util.List;
import jakarta.annotation.Resource;
public class GenericResourceConsumer {
  @Resource List<Gateway> missingGateways;
}
