package com.other;
import org.springframework.context.annotation.*;

@Configuration class WildcardConfiguration {
  @Bean Gateway gateway() { return new DefaultGateway(); }
}
interface Gateway {}
class DefaultGateway implements Gateway {}
