export interface User {
  id: number;
  name: string;
  email: string;
}

export function formatUser(user: User): string {
  return `${user.name} <${user.email}>`;
}
