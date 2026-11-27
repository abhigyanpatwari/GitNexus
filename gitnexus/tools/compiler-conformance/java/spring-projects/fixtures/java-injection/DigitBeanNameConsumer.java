package com.example;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;
@Service
public class DigitBeanNameConsumer {
  public DigitBeanNameConsumer(@Qualifier("s3Client") S3Client client) {}
}
