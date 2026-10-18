import { execSync } from 'child_process';

function runGit(value: string) { return execSync(value); }
function forward(value: string) { return runGit(value); }

export function namedHandler(req: any) {
  forward(req.query.command);
}

export function mount(app: any, req: any) {
  app.get('/inline', (req: any) => {
    forward(req.query.command);
  });
  app.get('/expression', function (req: any) {
    forward(req.query.command);
  });
  app.get('/async', async (req: any) => {
    forward(req.body.command);
  });
  app.get('/same-line', (req: any) => { forward(req.query.command); }); app.get('/constant', () => { forward('safe'); });
  const captured = req.query.command;
  app.get('/capture', () => { forward(captured); });
}

export function makeNamed() {
  return async function returnedHandler(req: any) {
    forward(req.query.command);
  };
}

export function makeAnonymous() {
  return async (req: any) => {
    forward(req.body.command);
  };
}

export function makeExpression() {
  return function (req: any) {
    forward(req.query.command);
  };
}

import fs from 'fs';
function readSnippet(value: string) { return fs.readFileSync(value, 'utf8'); }
export function namedSnippet(req: any) { readSnippet(req.query.path); }
export function mountSnippet(app: any) { app.get('/snippet', (req: any) => { readSnippet(req.query.path); }); }
// @ts-expect-error A named function expression binds only inside its handler.
export function outsideReturned(req: any) { returnedHandler(req.query.command); }

export function mountIdentity(app: any) {
  app.get('/identity', () => {
    function nestedIdentity() { return 1; }
    nestedIdentity();
  });
}

function compileFilter(expr: string) { return new Function('row', 'return (' + expr + ');'); }
function filterRows(expr: string) { return compileFilter(expr); }
export function makeFilterHandler() {
  return async function handleFilter(req: any) {
    filterRows(req.body.filter);
  };
}
