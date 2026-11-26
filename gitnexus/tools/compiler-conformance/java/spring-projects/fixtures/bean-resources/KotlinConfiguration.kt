package com.kotlin
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
@Configuration
class KotlinConfiguration {
  @Bean fun kotlinGateway(): KGateway = KGatewayImpl()
  @Bean(name = ["kotlinNamed", "kotlinAlias"])
  fun namedGateway(): KGateway = KGatewayImpl()
  @Bean fun inferredGateway() = KGatewayImpl()
  @Bean fun kotlinConcreteGateway() = KGatewayImpl()
  @Bean fun kotlinSelfAwareGateway(dependency: KGateway): KGateway = KGatewayImpl()
  private fun buildGateway(): KGateway = KGatewayImpl()
  @Bean fun indirectGateway() = buildGateway()
  @Bean fun kotlinList(): List<KGateway> = emptyList()
  @Bean @Autowired
  fun kotlinService(@param:Qualifier("kotlinAlias") gateway: KGateway): KRepo = KRepo()
}
