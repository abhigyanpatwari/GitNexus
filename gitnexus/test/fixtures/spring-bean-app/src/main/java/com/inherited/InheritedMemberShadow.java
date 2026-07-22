package com.inherited;

import org.springframework.stereotype.*;

class Base {
  @interface Service {}
}

class Holder extends Base {
  @Service
  static class InheritedMemberShadowedService {}
}
