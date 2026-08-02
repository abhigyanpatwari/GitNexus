package com.example;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * `frameworks/spring/conditionals.ts` mints one `Annotation` node per Spring
 * condition and links its OWNER to it with a CONDITIONAL_ON edge. When the
 * owner is an `@Bean` factory METHOD (rather than the `@Configuration` class),
 * the edge is `Method -> Annotation` — the source label comes from the
 * scope-resolution bridge, the target is a structural `Annotation` node that
 * is in neither scope-bridge label set.
 */
@Configuration
public class AppAutoConfiguration {

  @Bean
  @ConditionalOnMissingBean
  public PaymentService paymentService() {
    return new PaymentService();
  }

  @Bean
  @ConditionalOnProperty(prefix = "billing", name = "enabled", havingValue = "true")
  public PaymentService fallbackPaymentService() {
    return new PaymentService();
  }
}
