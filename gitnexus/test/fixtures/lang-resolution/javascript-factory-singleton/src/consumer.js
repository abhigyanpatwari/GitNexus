import { fooService } from './service.js';

/**
 * @param {string} id
 * @returns {string}
 */
export function caller(id) {
  return fooService.getUser(id);
}
