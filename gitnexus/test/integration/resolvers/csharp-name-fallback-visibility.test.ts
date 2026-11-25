/**
 * C#: the global-name fallback must not guess a type whose namespace the
 * caller cannot see.
 *
 * Repro from a Unity project vendoring a protobuf package: `new Color(1f, 0.5f,
 * 0f)` in a file with only `using UnityEngine;` names `UnityEngine.Color`
 * (external), yet received a 0.5 `global-name-fallback` CALLS edge to the
 * vendored `Vendor.Proto.Color` — a type C# would never bind there.
 *
 * Every visibility channel that DOES make the bare name legal must keep its
 * edge: an explicit `using`, an enclosing namespace, a `global using` in
 * another file, an MSBuild `<Using Include>` item, and a qualified call.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

const VENDOR_COLOR = `namespace Vendor.Proto
{
    public sealed class Color
    {
        public Color() { }
    }
}
`;

function callTargetsFrom(result: PipelineResult, caller: string, file: string) {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === caller && edge.sourceFilePath === file)
    .map((edge) => [edge.target, edge.targetFilePath]);
}

describe('C# global-name fallback respects namespace visibility', () => {
  const dirs: string[] = [];
  const analyze = async (files: Record<string, string>): Promise<PipelineResult> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-csharp-fallback-'));
    dirs.push(dir);
    writeFixtureRepo(dir, files);
    return runPipelineFromRepo(dir, () => {});
  };

  let plain: PipelineResult;
  beforeAll(async () => {
    plain = await analyze({
      'Lib/Color.cs': VENDOR_COLOR,
      'App/Unrelated.cs': `using UnityEngine;

namespace MyGame
{
    public class Unrelated
    {
        public void Paint() { var c = new Color(1f, 0.5f, 0f); }
    }
}
`,
      'App/GlobalNs.cs': `using UnityEngine;

public class GlobalNs
{
    public void Paint() { var c = new Color(1f, 0.5f, 0f); }
}
`,
      'App/Imported.cs': `using Vendor.Proto;

namespace MyGame
{
    public class Imported
    {
        public void Paint() { var c = new Color(); }
    }
}
`,
      'App/Nested.cs': `namespace Vendor.Proto.Tools
{
    public class Nested
    {
        public void Paint() { var c = new Color(); }
    }
}
`,
      'App/Qualified.cs': `namespace MyGame
{
    public class Qualified
    {
        public void Paint() { var c = new Vendor.Proto.Color(); }
    }
}
`,
    });
  }, 60_000);

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a bare type from a namespace the caller never imports', () => {
    expect(callTargetsFrom(plain, 'Paint', 'App/Unrelated.cs')).toEqual([]);
  });

  it('refuses the guess from a caller in the global namespace', () => {
    expect(callTargetsFrom(plain, 'Paint', 'App/GlobalNs.cs')).toEqual([]);
  });

  it('keeps the edge when the namespace is imported with `using`', () => {
    expect(callTargetsFrom(plain, 'Paint', 'App/Imported.cs')).toEqual([['Color', 'Lib/Color.cs']]);
  });

  it('keeps the edge from a namespace nested inside the type namespace', () => {
    expect(callTargetsFrom(plain, 'Paint', 'App/Nested.cs')).toEqual([['Color', 'Lib/Color.cs']]);
  });

  it('keeps the edge for a namespace-qualified construction', () => {
    expect(callTargetsFrom(plain, 'Paint', 'App/Qualified.cs')).toEqual([
      ['Color', 'Lib/Color.cs'],
    ]);
  });

  it('keeps the edge when another file declares `global using`', async () => {
    const result = await analyze({
      'Lib/Color.cs': VENDOR_COLOR,
      'GlobalUsings.cs': 'global using Vendor.Proto;\n',
      'App/Painter.cs': `namespace MyGame
{
    public class Painter
    {
        public void Paint() { var c = new Color(); }
    }
}
`,
    });
    expect(callTargetsFrom(result, 'Paint', 'App/Painter.cs')).toEqual([['Color', 'Lib/Color.cs']]);
  }, 60_000);

  it('keeps the edge when an MSBuild `<Using Include>` item imports the namespace', async () => {
    const result = await analyze({
      'Lib/Color.cs': VENDOR_COLOR,
      'App/App.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <Using Include="Vendor.Proto" />
  </ItemGroup>
</Project>
`,
      'App/Painter.cs': `namespace MyGame
{
    public class Painter
    {
        public void Paint() { var c = new Color(); }
    }
}
`,
    });
    expect(callTargetsFrom(result, 'Paint', 'App/Painter.cs')).toEqual([['Color', 'Lib/Color.cs']]);
  }, 60_000);
});
