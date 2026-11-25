package com.kotlinlocal
annotation class Bean
annotation class Resource
interface LocalGateway
class LocalConfiguration {
  @Bean fun localGateway(): LocalGateway = TODO()
}
class LocalResourceConsumer {
  @field:Resource lateinit var localGateway: LocalGateway
}
