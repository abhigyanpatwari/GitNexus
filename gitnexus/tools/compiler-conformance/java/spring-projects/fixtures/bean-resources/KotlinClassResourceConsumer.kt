package com.kotlin
import jakarta.annotation.Resource
class KotlinClassResourceConsumer {
  @field:Resource(name = "kotlinClassGateway")
  lateinit var gateway: KGateway
}
