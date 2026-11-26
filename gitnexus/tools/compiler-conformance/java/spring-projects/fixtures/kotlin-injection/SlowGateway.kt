package com.example
import org.springframework.stereotype.Service
@Service("slowGateway")
class SlowGateway : PaymentGateway
