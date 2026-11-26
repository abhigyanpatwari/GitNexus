package com.example.service;

import org.springframework.transaction.annotation.Transactional;

class InheritedBehaviorBase {
  @Transactional
  public void overriddenTransaction() {}
}

public class InheritedBehaviorService extends InheritedBehaviorBase {
  @Override
  public void overriddenTransaction() {}
}
