package com.example

import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.context.properties.ConfigurationProperties

class DirectValues {
  @Value("\${payment.timeout:30}")
  private var timeout: Int = 0

  @Value("\${payment.missing}")
  private var missing: String? = null
}

@ConfigurationProperties(prefix = "service")
class ServiceProperties {
  var endpoint: String? = null
  var retry: Retry? = null
}

@ConfigurationProperties("service")
class UnmatchedServiceProperties {
  var unrelated: String? = null
}

class Retry
