export class UserModel {
  constructor(
    public id: number,
    public name: string,
    public role: 'admin' | 'user',
  ) {}

  isAdmin(): boolean {
    return this.role === 'admin';
  }

  displayName(): string {
    return `${this.name} (${this.role})`;
  }
}

export class PostModel {
  constructor(
    public id: number,
    public title: string,
    public content: string,
    public authorId: number,
  ) {}

  summary(): string {
    return this.title.substring(0, 100);
  }

  wordCount(): number {
    return this.content.split(' ').length;
  }
}
