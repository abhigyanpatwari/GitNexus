package com.example;
import java.util.List;
import javax.annotation.Resource;
public class CollectionResourceConsumer {
  @Resource(name = "gatewayList") List<Gateway> gateways;
}
