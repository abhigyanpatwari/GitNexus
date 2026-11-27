package com.example
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
@Service
class QualifiedConsumer(
  @param:Qualifier("slowGateway") gateway: PaymentGateway,
)
