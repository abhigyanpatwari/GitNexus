import { GrpcMethod } from '@nestjs/microservices';

export class AuthController {
  @GrpcMethod('AuthService', 'Login')
  login(data: unknown): unknown {
    return { token: 'ok' };
  }
}
