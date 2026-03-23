export class Repo {
  name: string;
  constructor(name: string) { this.name = name; }
  save(): void {}
}

export function getRepos(): Repo[] {
  return [new Repo("main")];
}
