import './polyfill';
import './register';
import { greet } from './greeter';

export function main(): string {
  return greet('world');
}
