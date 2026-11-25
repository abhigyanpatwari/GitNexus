package com.example.service

import org.springframework.transaction.annotation.Transactional as Tx

class KotlinAliasedService {
  @Tx
  fun kotlinAliasedTransactionalOperation() {}

  fun kotlinAliasedPlainOperation() {}
}
