export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export function createTodo(text: string): Todo {
  return { id: Date.now(), text, done: false };
}

export function toggleTodo(todo: Todo): Todo {
  return { ...todo, done: !todo.done };
}

export function filterDone(todos: Todo[]): Todo[] {
  return todos.filter((t) => t.done);
}

export function filterPending(todos: Todo[]): Todo[] {
  return todos.filter((t) => !t.done);
}
