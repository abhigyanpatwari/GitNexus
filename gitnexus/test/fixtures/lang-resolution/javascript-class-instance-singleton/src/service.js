export class FooService {
  /**
   * @param {string} id
   * @returns {string}
   */
  getUser(id) {
    return id;
  }
}

export const fooService = new FooService();
