package com.example;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.ConfigurationProperties;

class DirectValues {
  @Value("${payment.timeout:30}")
  private int timeout;

  @Value("${payment.missing}")
  private String missing;
}

@ConfigurationProperties(prefix = "service")
class ServiceProperties {
  private String endpoint;
  private Retry retry;
}

@ConfigurationProperties("service")
class UnmatchedServiceProperties {
  private String unrelated;
}

class Retry {}
