import { getConfig } from './api';
export function run() {
  const c = getConfig();
  c.validate();
}
