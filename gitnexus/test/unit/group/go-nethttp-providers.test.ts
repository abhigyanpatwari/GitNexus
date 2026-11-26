/**
 * Group HTTP-contract layer: net/http-style providers. `HandleFunc` and
 * `Handle` register on any ServeMux-like receiver (`http`, a local
 * `http.NewServeMux()`, a gorilla or chi router), with a named, method-value
 * or inline handler (#1668). The registration accepts every HTTP method unless
 * a Go 1.22 pattern (`"POST /p"`) or a gorilla `.Methods(...)` chain names
 * them, so the provider is method-agnostic (`*`) by default (#1670).
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import { GO_HTTP_PLUGIN } from '../../../src/core/group/extractors/http-patterns/go.js';

const parser = new Parser();

function providers(body: string, fileRel = 'routes.go') {
  parser.setLanguage(Go);
  const src = `package main

import (
\t"net/http"

\t"github.com/go-chi/chi/v5"
\t"github.com/gorilla/mux"
\ttele "gopkg.in/telebot.v3"
)

func routes(api *API, r *mux.Router, s *Server) {
${body}
}
`;
  return GO_HTTP_PLUGIN.scan(parser.parse(src), undefined, fileRel)
    .filter((d) => d.role === 'provider')
    .map(({ method, path: p, name }) => ({ method, path: p, name }));
}

describe('Go net/http providers', () => {
  it.each([
    {
      shape: 'package-level http.HandleFunc',
      body: '\thttp.HandleFunc("/api/users", listUsers)',
      expected: [{ method: '*', path: '/api/users', name: 'listUsers' }],
    },
    {
      shape: 'a local ServeMux',
      body: '\tm := http.NewServeMux()\n\tm.HandleFunc("/api/health", health)',
      expected: [{ method: '*', path: '/api/health', name: 'health' }],
    },
    {
      shape: 'a method-value handler',
      body: '\tm := http.NewServeMux()\n\tm.HandleFunc("/api/users", api.ListUsers)',
      expected: [{ method: '*', path: '/api/users', name: 'ListUsers' }],
    },
    {
      shape: 'Handle with an http.Handler value',
      body: '\thttp.Handle("/api/items", itemsHandler)',
      expected: [{ method: '*', path: '/api/items', name: 'itemsHandler' }],
    },
    {
      shape: 'an inline handler',
      body: '\thttp.HandleFunc("/api/inline", func(w http.ResponseWriter, r *http.Request) {})',
      expected: [{ method: '*', path: '/api/inline', name: null }],
    },
    {
      shape: 'a raw string path',
      body: '\thttp.HandleFunc(`/api/raw`, raw)',
      expected: [{ method: '*', path: '/api/raw', name: 'raw' }],
    },
    {
      shape: 'a Go 1.22 method pattern',
      body: '\thttp.HandleFunc("POST /api/users", createUser)',
      expected: [{ method: 'POST', path: '/api/users', name: 'createUser' }],
    },
    {
      shape: 'a Go 1.22 method and host pattern',
      body: '\thttp.HandleFunc("GET example.com/api/items/{id}", getItem)',
      expected: [{ method: 'GET', path: '/api/items/{id}', name: 'getItem' }],
    },
    {
      shape: 'a Go 1.22 exact-match anchor',
      body: '\thttp.HandleFunc("/api/exact/{$}", exact)',
      expected: [{ method: '*', path: '/api/exact/', name: 'exact' }],
    },
    {
      shape: 'a gorilla Methods chain',
      body: '\tr.HandleFunc("/api/orders", api.Order).Methods("POST", http.MethodPut)',
      expected: [
        { method: 'POST', path: '/api/orders', name: 'Order' },
        { method: 'PUT', path: '/api/orders', name: 'Order' },
      ],
    },
    {
      shape: 'a gorilla route without Methods',
      body: '\tr.Handle("/api/any", anyHandler).Name("any")',
      expected: [{ method: '*', path: '/api/any', name: 'anyHandler' }],
    },
    {
      shape: 'an http.HandlerFunc conversion',
      body: '\thttp.Handle("/api/conv", http.HandlerFunc(conv))',
      expected: [{ method: '*', path: '/api/conv', name: 'conv' }],
    },
    {
      shape: 'a hyphenated method token',
      body: '\thttp.HandleFunc("M-SEARCH /discover", discover)',
      expected: [{ method: 'M-SEARCH', path: '/discover', name: 'discover' }],
    },
    {
      shape: 'a HEAD-only pattern, kept apart from GET consumers',
      body: '\thttp.HandleFunc("HEAD /api/ping", ping)\n\tr.HandleFunc("/api/both", both).Methods("GET", "HEAD", "GET")',
      expected: [
        { method: 'HEAD', path: '/api/ping', name: 'ping' },
        { method: 'GET', path: '/api/both', name: 'both' },
        { method: 'HEAD', path: '/api/both', name: 'both' },
      ],
    },
    {
      shape: 'a router parameter mounted under a stripped prefix',
      body: '}\n\nfunc serve(root, sub *http.ServeMux) {\n\tsub.HandleFunc("/users", users)\n\troot.Handle("/api/", http.StripPrefix("/api", sub))',
      expected: [],
    },
    {
      shape: 'a gorilla Methods chain after other route matchers',
      body: '\tr.HandleFunc("/api/hosted", hosted).Host("api.example.com").Methods("POST")',
      expected: [{ method: 'POST', path: '/api/hosted', name: 'hosted' }],
    },
    {
      shape: 'a gorilla PathPrefix subrouter',
      body: '\tv1 := r.PathPrefix("/api").Subrouter()\n\tv1.HandleFunc("/users", users).Methods("GET")',
      expected: [{ method: 'GET', path: '/api/users', name: 'users' }],
    },
    {
      shape: 'a chi Route callback',
      body: '\tc := chi.NewRouter()\n\tc.Route("/api", func(r chi.Router) {\n\t\tr.HandleFunc("/users", users)\n\t})',
      expected: [{ method: '*', path: '/api/users', name: 'users' }],
    },
    {
      shape: 'a router mounted under a stripped prefix',
      body: '\tsub := http.NewServeMux()\n\tsub.HandleFunc("/users", users)\n\thttp.Handle("/api/", http.StripPrefix("/api", sub))',
      expected: [],
    },
    {
      shape: 'a chi router mounted from a builder',
      body: '\tc := chi.NewRouter()\n\tc.Mount("/api", apiRouter())\n}\n\nfunc apiRouter() chi.Router {\n\tsub := chi.NewRouter()\n\tsub.HandleFunc("/users", users)\n\treturn sub',
      expected: [],
    },
    {
      shape: 'a telebot handler with a slash command',
      body: '\tb, _ := tele.NewBot(tele.Settings{})\n\tb.Handle("/start", onStart)',
      expected: [],
    },
    {
      shape: 'a struct-field router whose mounts are unknown',
      body: '\ts.router.HandleFunc("/api/field", s.field)',
      expected: [],
    },
    {
      shape: 'a gorilla path without a leading slash',
      body: '\tr.HandleFunc("api/users", users)',
      expected: [],
    },
    {
      shape: 'a pattern whose first token is not a method',
      body: '\thttp.HandleFunc("/search /results", search)',
      expected: [],
    },
    {
      shape: 'a non-path first argument',
      body: '\tbus.Handle("user.created", onCreated)',
      expected: [],
    },
    {
      shape: 'a computed path',
      body: '\thttp.HandleFunc(prefix+"/x", handler)',
      expected: [],
    },
    {
      shape: 'a handler that is not a function value',
      body: '\thttp.Handle("/static/", http.StripPrefix("/static/", files))',
      expected: [],
    },
  ])('reads $shape', ({ body, expected }) => {
    expect(providers(body)).toEqual(expected);
  });

  it('skips httptest mock routers in _test.go files', () => {
    const body = '\tm := http.NewServeMux()\n\tm.HandleFunc("/api/users", users)';
    expect([providers(body, 'client_test.go'), providers(body, 'client.go')]).toEqual([
      [],
      [{ method: '*', path: '/api/users', name: 'users' }],
    ]);
  });
});
