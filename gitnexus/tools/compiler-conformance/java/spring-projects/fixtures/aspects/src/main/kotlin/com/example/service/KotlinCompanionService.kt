package com.example.service

import org.springframework.transaction.annotation.Transactional

class KotlinCompanionService {
  companion object {
    @Transactional
    fun kotlinCompanionTransaction() {}

    @receiver:Transactional
    fun String.kotlinReceiverTargetTransaction() {}
  }
}
