package com.example
import org.springframework.stereotype.Service
@Service
class MutableCollectionConsumer(val gateways: MutableList<PaymentGateway?>?)
