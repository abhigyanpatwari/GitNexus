export interface UserConfig {
  name: string;
  email: string;
  active: boolean;
}

export function validateUser(config: UserConfig): boolean {
  return config.name.length > 0 && config.email.includes('@');
}

export class UserService {
  private users: UserConfig[] = [];

  addUser(user: UserConfig): void {
    if (validateUser(user)) {
      this.users.push(user);
    }
  }

  getUser(name: string): UserConfig | undefined {
    return this.users.find(u => u.name === name);
  }
}

function internalHelper(): string {
  return 'helper';
}
