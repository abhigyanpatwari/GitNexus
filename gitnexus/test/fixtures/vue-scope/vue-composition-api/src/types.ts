export interface User {
  id: number;
  name: string;
  email: string;
}

export interface Post {
  id: number;
  title: string;
  authorId: number;
}

export function formatUser(user: User): string {
  return `${user.name} <${user.email}>`;
}

export function formatPost(post: Post): string {
  return `[${post.id}] ${post.title}`;
}
