package com.example;
import java.util.List;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
@Configuration
public class AppConfiguration {
  @Bean Gateway gateway() { return new DefaultGateway(); }
  @Bean(name = {"slowGateway", "gatewayAlias"})
  Gateway namedGateway() { return new DefaultGateway(); }
  @Bean Gateway setterGateway() { return new DefaultGateway(); }
  @Bean DefaultGateway concreteGateway() { return new DefaultGateway(); }
  @Bean Gateway selfAwareGateway(Gateway dependency) { return new DefaultGateway(); }
  @Bean List<Gateway> gatewayList() { return List.of(); }
  @Bean ConcreteRepo repo() { return new ConcreteRepo(); }
  @Bean @Autowired
  ConcreteRepo service(@Qualifier("gatewayAlias") Gateway gateway) {
    return new ConcreteRepo();
  }
  @Bean ConcreteRepo aggregate(List<Gateway> gateways) {
    return new ConcreteRepo();
  }
}
