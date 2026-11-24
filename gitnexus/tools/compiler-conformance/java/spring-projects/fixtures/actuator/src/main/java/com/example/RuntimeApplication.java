package com.example;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class OrderController {
  @GetMapping("/orders")
  String list() { return helper(); }
  String helper() { return leaf(); }
  String leaf() { return "ok"; }
  String lookup(String id) { return id; }
  String lookup(Integer id) { return id.toString(); }
  String tags(String... values) { return String.join(",", values); }
}

class SiblingController {
  String list() { return "not-the-handler"; }
}

@Service
class BillingService {}

@Configuration
class RuntimeConfig {
  @Bean
  @ConditionalOnProperty(prefix = "app.billing", name = "enabled")
  BillingService billingService() { return new BillingService(); }
}

class SiblingConfig {
  BillingService billingService() { return new BillingService(); }
}

@ConfigurationProperties(prefix = "app.billing")
class BillingProperties {
  String url;
}
