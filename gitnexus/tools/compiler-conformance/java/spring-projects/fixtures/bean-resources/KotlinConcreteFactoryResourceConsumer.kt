package com.kotlin
import jakarta.annotation.Resource
class KotlinConcreteFactoryResourceConsumer {
  @field:Resource(name = "kotlinConcreteGateway")
  lateinit var gateway: KGateway
}
