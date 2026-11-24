package com.example.service;

import org.springframework.transaction.annotation.Transactional;

@Transactional
public class ClassLevelService {
  public void inheritedTransaction() {}
  private void privateHelper() {}
  public static void staticHelper() {}
}
