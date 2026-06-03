import type { User, Post } from './types';

export async function fetchUser(id: number): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json() as Promise<User>;
}

export async function fetchPosts(userId: number): Promise<Post[]> {
  const response = await fetch(`/api/users/${userId}/posts`);
  return response.json() as Promise<Post[]>;
}

export function saveUser(user: User): Promise<User> {
  return fetch('/api/users', {
    method: 'POST',
    body: JSON.stringify(user),
  }).then((r) => r.json() as Promise<User>);
}
