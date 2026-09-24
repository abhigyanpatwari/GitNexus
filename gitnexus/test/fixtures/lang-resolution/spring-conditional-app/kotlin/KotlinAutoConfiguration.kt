package com.example.kotlin

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

class ReportService

/**
 * Kotlin twin of the Java `@Bean` + `@ConditionalOnMissingBean` case — the same
 * `Method -> Annotation` pair, reached through the Kotlin conditional metadata
 * adapter instead of the Java one.
 */
@Configuration
class KotlinAutoConfiguration {

  @Bean
  @ConditionalOnMissingBean
  fun reportService(): ReportService = ReportService()
}
