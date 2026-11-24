package com.example.service;

import org.springframework.transaction.annotation.Transactional;

@Transactional
public interface TransactionalOperations {
  void interfaceInheritedTransaction();
}
