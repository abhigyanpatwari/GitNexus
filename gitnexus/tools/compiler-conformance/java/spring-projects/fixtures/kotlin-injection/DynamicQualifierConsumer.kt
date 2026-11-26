package com.example
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service
const val GATEWAY = "slowGateway"
@Service
class DynamicQualifierConsumer(@Qualifier(GATEWAY) gateway: PaymentGateway)
