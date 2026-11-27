package com.example

import org.springframework.boot.autoconfigure.AutoConfiguration
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile

@Profile("dev")
class ProfiledKotlinConfig

@Configuration
class KotlinBeanConfig {
  @Bean
  @ConditionalOnProperty(prefix = """feature.search""", name = ["""enabled"""])
  fun searchService(): Any = Any()
}

@AutoConfiguration
@ConditionalOnMissingBean(name = ["client"])
class KotlinAutoConfig
