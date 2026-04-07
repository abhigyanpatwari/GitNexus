export class Repo {
  constructor(private readonly path: string) {}

  save(): boolean {
    return this.path.length > 0;
  }
}
