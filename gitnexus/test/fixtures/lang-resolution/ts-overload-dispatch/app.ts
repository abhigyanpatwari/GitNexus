import { SqlRepository } from './sql-repository';

const repo = new SqlRepository();
repo.find(42);
repo.find('alice');
repo.save('test');
