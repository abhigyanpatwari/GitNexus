import type { SourceSinkSanitizerSpec } from './source-sink-config.js';

/** Conservative Phoenix/Ecto and dynamic-evaluation model. */
export const ELIXIR_TAINT_MODEL: SourceSinkSanitizerSpec = {
  sources: [
    // `params["id"]` is represented by the Elixir grammar as an access call,
    // whose conservative structural fact is `params.params`.
    {
      kind: 'remote-input',
      objects: ['conn', 'socket'],
      properties: ['params', 'body_params', 'query_params', 'path_params'],
    },
    { kind: 'remote-input', objects: ['params'], properties: ['params'] },
  ],
  sinks: [
    { name: 'eval_string', kind: 'code-injection', args: [0], receivers: ['Code'] },
    { name: 'eval_quoted', kind: 'code-injection', args: [0], receivers: ['Code'] },
    { name: 'apply', kind: 'code-injection', args: [0], receivers: ['erlang', ':erlang'] },
    { name: 'apply', kind: 'code-injection', args: [0], receivers: ['Kernel'] },
    { name: 'apply', kind: 'code-injection', args: [0], global: true },
    // Raw SQL/query APIs only: parameterized Repo.query(sql, params) is not a
    // finding for params, because only SQL text (argument zero) is modelled.
    { name: 'query', kind: 'sql-injection', args: [0], receivers: ['Repo'] },
    { name: 'query!', kind: 'sql-injection', args: [0], receivers: ['Repo'] },
    { name: 'query', kind: 'sql-injection', args: [1], receivers: ['Ecto.Adapters.SQL'] },
    { name: 'query!', kind: 'sql-injection', args: [1], receivers: ['Ecto.Adapters.SQL'] },
  ],
  sanitizers: [],
};
