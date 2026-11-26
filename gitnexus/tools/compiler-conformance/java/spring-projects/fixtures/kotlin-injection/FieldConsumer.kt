package com.example
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.stereotype.Service
@Service
class FieldConsumer {
  @field:Autowired
  lateinit var gateway: PaymentGateway
}
