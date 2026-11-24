package com.kotlin
import jakarta.annotation.Resource
class KotlinExplicitResourceConsumer {
  @field:Resource(name = "kotlinNamed")
  lateinit var selected: KGateway
}
