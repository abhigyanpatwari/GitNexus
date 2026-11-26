package com.example
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.stereotype.Service
@Service
class GetterTargetConsumer {
  @get:Autowired
  var gateway: PaymentGateway? = null
}
