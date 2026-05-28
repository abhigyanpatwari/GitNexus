// Negative fixture: array method calls whose callback is an arrow must NOT
// be classified as Functions. The variable holds the transformed array, not a
// reusable function. Pre-fix these were incorrectly tagged as Function nodes.
//
// The names `mappedData`, `filtered`, `reduced` must NOT appear as Function
// nodes in the graph, and calls inside the callbacks (doStuff) must NOT
// attribute to those names.

import { doStuff } from './helpers';

interface Account { id: number }

declare const accountsList: Account[];

export const mappedData = accountsList.map((account) => ({
  id: doStuff(account.id),
}));

export const filtered = accountsList.filter((account) => doStuff(account.id) > 0);

export const reduced = accountsList.reduce((acc, account) => {
  doStuff(account.id);
  return acc + account.id;
}, 0);
