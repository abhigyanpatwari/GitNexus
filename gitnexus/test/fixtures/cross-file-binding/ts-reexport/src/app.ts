import { getConfig } from './index';
export function init() {
  const config = getConfig();
  config.validate();
}
