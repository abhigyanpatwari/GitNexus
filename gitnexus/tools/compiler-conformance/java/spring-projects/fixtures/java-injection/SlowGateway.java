package com.example;
import org.springframework.stereotype.Service;
@Service("slowGateway")
public class SlowGateway implements PaymentGateway {}
