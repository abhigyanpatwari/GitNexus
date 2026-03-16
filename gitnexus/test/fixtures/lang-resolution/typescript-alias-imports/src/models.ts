export class User {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  save(): boolean {
    return true;
  }
}

export class Repo {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  persist(): boolean {
    return true;
  }
}
