import { format } from 'node:util';

// Register every table entry as a separately reported native test or suite.
export function registerCases(register, rows, title, run, timeout) {
  for (const [index, row] of rows.entries()) {
    const args = Array.isArray(row) ? row : [row];
    let position = 0;
    const name = title.replace(/%#|%[sijdfo]|\$(\w+)/g, (token, key) => {
      if (token === '%#') return String(index);
      if (key) return String(row[key]);
      return format(token, args[position++]);
    });
    register(name, { timeout }, () => run(...args));
  }
}
