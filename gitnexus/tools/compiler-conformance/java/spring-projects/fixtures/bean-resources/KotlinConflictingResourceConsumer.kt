package com.kotlin
import jakarta.annotation.Resource
import org.springframework.beans.factory.annotation.Autowired
class KotlinConflictingResourceConsumer {
  @field:Autowired
  @field:Resource
  lateinit var gateways: List<KGateway>
}
