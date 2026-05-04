import { describe, expect, it } from 'vitest';
import { emitGoScopeCaptures } from '../../../../src/core/ingestion/languages/go/index.js';

const tagNames = (matches: readonly Record<string, unknown>[]) =>
  matches.flatMap((m) => Object.keys(m));

describe('Go scope captures — smoke', () => {
  it('emits grouped imports once per import spec', () => {
    const src = `
package main

import (
  "fmt"
  "os"
)
`;
    const matches = emitGoScopeCaptures(src, 'main.go');
    const imports = matches
      .filter((m) => m['@import.source'] !== undefined)
      .map((m) => m['@import.source']!.text);

    expect(imports).toEqual(['fmt', 'os']);
  });

  it('emits module, struct, interface, function, method, import, call, read, write captures', () => {
    const src = `
package main

import (
  "example.com/app/internal/models"
  util "example.com/app/internal/util"
)

type User struct { Name string }
type Saver interface { Save() }

func NewUser(name string) *User { return &User{Name: name} }

func (u *User) Save(prefix string) { util.Log(prefix); models.Touch() }

func main() {
  u := NewUser("alice")
  u.Save("hello")
  fmt.Println(u.Name)
  u.Name = "bob"
}
`;
    const matches = emitGoScopeCaptures(src, 'cmd/main.go');
    const tags = tagNames(matches);

    expect(tags).toContain('@scope.module');
    expect(tags).toContain('@scope.class');
    expect(tags).toContain('@scope.function');
    expect(tags).toContain('@declaration.struct');
    expect(tags).toContain('@declaration.interface');
    expect(tags).toContain('@declaration.function');
    expect(tags).toContain('@declaration.method');
    expect(tags).toContain('@import.statement');
    expect(tags).toContain('@reference.call.free');
    expect(tags).toContain('@reference.call.member');
    expect(tags).toContain('@reference.call.constructor');
    expect(tags).toContain('@reference.read');
    expect(tags).toContain('@reference.write');
  });
});
