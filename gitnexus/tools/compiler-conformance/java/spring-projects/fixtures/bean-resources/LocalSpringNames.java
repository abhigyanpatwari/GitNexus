package com.local;
@interface Bean {}
@interface Resource {}
interface LocalGateway {}
class LocalConfiguration {
  @Bean LocalGateway localGateway() { return null; }
}
class LocalResourceConsumer {
  @Resource LocalGateway localGateway;
}
