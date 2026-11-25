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

  it('ignores an MSBuild `<Using Include>` inside an XML comment', async () => {
    const result = await analyze({
      'Lib/Color.cs': VENDOR_COLOR,
      'App/App.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <!-- <Using Include="Vendor.Proto" /> -->
  </ItemGroup>
</Project>
`,
      'App/Painter.cs': PAINTER_IN_MYGAME,
    });
    expect(callTargetsFrom(result, 'Paint', 'App/Painter.cs')).toEqual([]);
  }, 60_000);

  it('does not treat an aliased MSBuild `<Using Alias>` as a namespace import', async () => {
    const result = await analyze({
      'Lib/Color.cs': VENDOR_COLOR,
      'App/App.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <Using Include="Vendor.Proto" Alias="VP" />
  </ItemGroup>
</Project>
`,
      'App/GlobalUsings.cs': 'global using Proto = Vendor.Proto;\n',
      'App/Painter.cs': PAINTER_IN_MYGAME,
    });
    expect(callTargetsFrom(result, 'Paint', 'App/Painter.cs')).toEqual([]);
  }, 60_000);

  it('scopes a `global using` to the project that declares it', async () => {
    const result = await analyze({
      'Lib/Color.cs': VENDOR_COLOR,
      'A/A.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
      'A/GlobalUsings.cs': 'global using Vendor.Proto;\n',
      'A/Painter.cs': PAINTER_IN_MYGAME,
      'B/B.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
      'B/Painter.cs': PAINTER_IN_MYGAME,
    });
    expect(callTargetsFrom(result, 'Paint', 'A/Painter.cs')).toEqual([['Color', 'Lib/Color.cs']]);
    expect(callTargetsFrom(result, 'Paint', 'B/Painter.cs')).toEqual([]);
  }, 60_000);

  it('applies a `Directory.Build.props` `<Using>` to every project below it', async () => {
    const result = await analyze({
      'Lib/Color.cs': VENDOR_COLOR,
      'src/Directory.Build.props': `<Project>
  <ItemGroup><Using Include="Vendor.Proto" /></ItemGroup>
</Project>
`,
      'src/B/B.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
      'src/B/Painter.cs': PAINTER_IN_MYGAME,
      'other/C.csproj': '<Project Sdk="Microsoft.NET.Sdk" />\n',
      'other/Painter.cs': PAINTER_IN_MYGAME,
    });
    expect(callTargetsFrom(result, 'Paint', 'src/B/Painter.cs')).toEqual([
      ['Color', 'Lib/Color.cs'],
    ]);
    expect(callTargetsFrom(result, 'Paint', 'other/Painter.cs')).toEqual([]);
  }, 60_000);
});

const PAINTER_IN_MYGAME = `namespace MyGame
{
    public class Painter
    {
        public void Paint() { var c = new Color(); }
    }
}
`;

describe('C# global-name fallback: using and namespace scoping', () => {
  let repoDir: string;
  let result: PipelineResult;
  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-csharp-fallback-scope-'));
    writeFixtureRepo(repoDir, {
      // `Vendor.Tools` is a declared namespace holding `Gadget`.
      'Lib/Gadget.cs': 'namespace Vendor.Tools { public class Gadget { public Gadget() { } } }\n',
      'App/RelativeElsewhere.cs': `namespace Game
{
    using Tools;

    public class RelativeElsewhere
    {
        public void Build() { var g = new Gadget(); }
    }
}
`,
      'App/RelativeInside.cs': `namespace Vendor.App
{
    using Tools;

    public class RelativeInside
    {
        public void Build() { var g = new Gadget(); }
    }
}
`,
      'App/TwoNamespaces.cs': `namespace Vendor.Tools.Extra
{
    public class Helper { }
}

namespace Game
{
    public class Caller
    {
        public void Build() { var g = new Gadget(); }
    }
}
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 60_000);
  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('resolves a relative using against the site namespace, not any suffix', () => {
    expect(callTargetsFrom(result, 'Build', 'App/RelativeElsewhere.cs')).toEqual([]);
    expect(callTargetsFrom(result, 'Build', 'App/RelativeInside.cs')).toEqual([
      ['Gadget', 'Lib/Gadget.cs'],
    ]);
  });

  it('uses the namespace enclosing the call site, not every namespace in the file', () => {
    expect(callTargetsFrom(result, 'Build', 'App/TwoNamespaces.cs')).toEqual([]);
  });
});
