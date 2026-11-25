package com.kotlin
import jakarta.annotation.Resource
class KotlinSetterResourceConsumer {
  @Resource fun setInferredGateway(value: KGatewayImpl) {}
}
