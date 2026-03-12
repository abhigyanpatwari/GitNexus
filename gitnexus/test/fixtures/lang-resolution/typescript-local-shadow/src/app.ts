import { save } from './utils';

// Local definition shadows the imported one
function save(x: string): void {
  console.log('local save:', x);
}

function run(): void {
  save('test');
}
