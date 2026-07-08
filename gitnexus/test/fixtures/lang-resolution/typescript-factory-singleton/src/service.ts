export class FooService {
  getUser(id: string) {
    return id;
  }
}

export function makeFooService(): FooService {
  return new FooService();
}

export const fooService = makeFooService();
