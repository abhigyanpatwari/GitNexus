package com.example;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

@Profile({"prod‮", "staging​"})
class ProfiledJavaConfig {}

@Configuration
class JavaBeanConfig {
  @Bean
  @ConditionalOnProperty(prefix = "feature.payments", name = {"enabled"}, havingValue = "true")
  Object paymentService() { return new Object(); }

  @Bean
  @ConditionalOnBooleanProperty(prefix = "feature.search", name = "enabled")
  Object booleanSearchService() { return new Object(); }

  @Bean
  @ConditionalOnProperty(prefix = """
      feature.payments
      """, name = """
      enabled
      """)
  Object textBlockPaymentService() { return new Object(); }
}

@AutoConfiguration
@ConditionalOnClass(name = "com.acme.Driver")
class JavaAutoConfig {}

@Configuration
class OrdinaryApplicationConfig {}
