package com.example
import org.springframework.stereotype.Service
@Service
class ConstructorConsumer(
  val gateway: PaymentGateway,
  repo: ConcreteRepo?,
)
