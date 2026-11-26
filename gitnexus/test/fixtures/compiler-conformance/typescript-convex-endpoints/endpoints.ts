import { queryGeneric as query, mutationGeneric as write } from 'convex/server';
import { query as generatedQuery, internalAction as internalRun } from './_generated/server';
import { query as dbQuery } from './database';

export const publicQuery = // legal line-comment trivia
  query({ handler: async () => null });
export const aliasedWrite = write({ handler: async () => null });
export const generatedAction = internalRun({ handler: async () => null });
export const bareHandler = generatedQuery(async () => null);
export const unrelatedQuery = dbQuery({ handler: async () => null });
