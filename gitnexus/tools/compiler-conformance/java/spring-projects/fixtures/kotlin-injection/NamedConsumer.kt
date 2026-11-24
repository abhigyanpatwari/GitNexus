package com.example
import jakarta.inject.Named
import org.springframework.stereotype.Service
@Service
class NamedConsumer(@Named("slowGateway") gateway: PaymentGateway)
