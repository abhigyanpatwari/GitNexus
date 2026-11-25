package com.example
import org.springframework.stereotype.Service
@Service
class CollectionConsumer(val gateways: List<out PaymentGateway>)
