export const listUsers = () => fetch('/api/users');
export const createUser = (body: string) => fetch('/api/users', { method: 'POST', body });
