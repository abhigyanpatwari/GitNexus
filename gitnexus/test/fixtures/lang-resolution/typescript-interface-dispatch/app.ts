import { SqlRepository } from './sql-repository';

const repo = new SqlRepository();
repo.find(1);
repo.save("test");
