export class FooService {
  /**
   * @param {string} id
   * @returns {string}
   */
  getUser(id) {
    return id;
  }
}

/**
 * @returns {FooService}
 */
export function makeFooService() {
  return new FooService();
}

export const fooService = makeFooService();
