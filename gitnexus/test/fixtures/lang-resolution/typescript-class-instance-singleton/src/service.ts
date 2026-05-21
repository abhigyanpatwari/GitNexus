export class FooService {
  getUser(id: string) {
    return id;
  }
}

export const fooService = new FooService();
