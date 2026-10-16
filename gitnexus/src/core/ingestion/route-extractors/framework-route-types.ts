import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';

/** Provider-private facts. Only JSON values cross the worker/cache boundary. */
export type FrameworkExpression =
  | { kind: 'unknown' }
  | { kind: 'handler' }
  | { kind: 'array'; elements: FrameworkExpression[] }
  | { kind: 'binding'; id: string }
  | { kind: 'import'; source: string; name: string }
  | { kind: 'member'; object: FrameworkExpression; name: string }
  | {
      kind: 'call';
      id: string;
      callee: FrameworkExpression;
      construct: boolean;
      argumentCount: number;
      paths: string[] | null;
    };

export interface FrameworkCallFact {
  receiver: FrameworkExpression;
  method: string;
  arguments: FrameworkExpression[];
  paths: string[] | null;
  lineNumber: number;
  handlerName?: string;
}

export interface FrameworkRouteFacts {
  filePath: string;
  bindings: { id: string; value: FrameworkExpression }[];
  exports: { name: string; value: FrameworkExpression }[];
  starExports: string[];
  invalidBindings: string[];
  /** Property writes invalidate the value behind aliases, including imports. */
  mutations: FrameworkExpression[];
  calls: FrameworkCallFact[];
}

export interface FrameworkAllocation {
  id: string;
  kind: 'app' | 'router' | 'hono';
}

/** Source registration identity survives mount expansion for provider adapters. */
export interface FrameworkRoute extends ExtractedDecoratorRoute {
  frameworkCall?: FrameworkCallFact;
}

export interface FrameworkRegistration {
  receiverId: string;
  framework: 'express' | 'hono';
  route: FrameworkRoute;
}

export interface FrameworkMount {
  parentId: string;
  childId: string;
  /** null records an incoming mount whose path cannot be established. */
  prefixes: string[] | null;
}

/** Resolved provenance, ready for mount composition before emission. */
export interface ResolvedFrameworkRoutes {
  allocations: FrameworkAllocation[];
  registrations: FrameworkRegistration[];
  mounts: FrameworkMount[];
}

/** Existing ScopeResolver configuration remains the authority for module targets. */
export type FrameworkImportResolver = (
  fromFile: string,
  moduleSpecifier: string,
) => readonly string[];
