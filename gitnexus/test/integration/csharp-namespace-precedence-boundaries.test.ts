import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('C# namespace lookup boundaries', () => {
  it.each([
    {
      name: 'an earlier dotted namespace cannot override a later namespace',
      files: {
        'Mixed.cs': `namespace Billing.Reports { public class Empty {} }
namespace Audit { public class Checker { public void Check() { var v = new Voucher(); v.Post(); } } }`,
        'Billing.cs': 'namespace Billing; public class Voucher { public void Post() {} }',
        'Audit.cs': 'namespace Audit; public class Voucher { public void Post() {} }',
      },
      caller: 'Check',
      member: 'Post',
      target: 'Audit.cs',
    },
    {
      name: 'a using inside one namespace cannot leak into a sibling namespace',
      files: {
        'Mixed.cs': `namespace Tools {
using Lib;
public class Empty {}
}
namespace Consumer { public class Runner { public void Run() { var t = new Token(); t.Go(); } } }`,
        'Lib.cs': 'namespace Lib; public class Token { public void Go() {} }',
        'Global.cs': 'public class Token { public void Go() {} }',
      },
      caller: 'Run',
      member: 'Go',
      target: 'Global.cs',
    },
    {
      name: 'a bare type name cannot select a generic type with a different arity',
      files: {
        'Global.cs': 'public class ArityToken { public static void Apply() {} }',
        'Client.cs': `namespace Client {
public class ArityToken<T> { public static void Apply() {} }
public class Runner { public void Run() { ArityToken.Apply(); } }
}`,
      },
      caller: 'Run',
      member: 'Apply',
      target: 'Global.cs',
    },
    {
      name: 'a generic class keeps its own short name inside its body',
      files: {
        'Global.cs': 'public class ArityToken { public static void Apply() {} }',
        'Client.cs': `namespace Client {
public class ArityToken<T> {
public static void Apply() {}
public static void Run() { ArityToken.Apply(); }
}
}`,
      },
      caller: 'Run',
      member: 'Apply',
      target: 'Client.cs',
    },
    {
      name: 'an incompatible generic type cannot hide an enclosing zero-arity type',
      files: {
        'Billing.cs':
          'namespace Billing; public class ArityToken { public static void Apply() {} }',
        'Client.cs': `namespace Billing.Client {
public class ArityToken<T> { public static void Apply() {} }
public class Runner { public void Run() { ArityToken.Apply(); } }
}`,
      },
      caller: 'Run',
      member: 'Apply',
      target: 'Billing.cs',
    },
    {
      name: 'a same-name alias to a closed generic remains a class receiver',
      files: {
        'Use.cs':
          'using Result = Lib.Result<string>; public class Runner { public void Run() { Result.Apply(); } }',
        'Lib.cs': 'namespace Lib; public class Result<T> { public static void Apply() {} }',
        'Global.cs': 'public class Result { public static void Apply() {} }',
      },
      caller: 'Run',
      member: 'Apply',
      target: 'Lib.cs',
    },
    {
      name: 'a nested block namespace uses its qualified identity',
      files: {
        'Use.cs': `namespace A {
namespace B {
public class Runner { public void Run() { var t = new Token(); t.Go(); } }
}
}`,
        'AB.cs': 'namespace A.B; public class Token { public void Go() {} }',
        'A.cs': 'namespace A; public class Token { public void Go() {} }',
        'B.cs': 'namespace B; public class Token { public void Go() {} }',
      },
      caller: 'Run',
      member: 'Go',
      target: 'AB.cs',
    },
    {
      name: 'a trailing semicolon does not make a block namespace file-scoped',
      files: {
        'Use.cs': `namespace Tools {
using Lib;
public class Empty {}
};
public class Runner { public void Run() { var t = new Token(); t.Go(); } }`,
        'Lib.cs': 'namespace Lib; public class Token { public void Go() {} }',
        'Global.cs': 'public class Token { public void Go() {} }',
      },
      caller: 'Run',
      member: 'Go',
      target: 'Global.cs',
    },
    {
      name: 'a file-scoped namespace may put its semicolon on the next line',
      files: {
        'Use.cs': `namespace Actual
;
public class Runner { public void Run() { var t = new Token(); t.Go(); } }`,
        'Actual.cs': 'namespace Actual; public class Token { public void Go() {} }',
        'Global.cs': 'public class Token { public void Go() {} }',
      },
      caller: 'Run',
      member: 'Go',
      target: 'Actual.cs',
    },
    {
      name: 'comment punctuation cannot classify a block namespace as file-scoped',
      files: {
        'Use.cs': `namespace Tools /* ; */
{
using Lib;
public class Empty {}
};
public class Runner { public void Run() { var t = new Token(); t.Go(); } }`,
        'Lib.cs': 'namespace Lib; public class Token { public void Go() {} }',
        'Global.cs': 'public class Token { public void Go() {} }',
      },
      caller: 'Run',
      member: 'Go',
      target: 'Global.cs',
    },
  ])(
    '$name',
    async ({ files, caller, member, target }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'csharp-lookup-boundary-'));
      try {
        for (const [name, content] of Object.entries(files)) {
          await fs.writeFile(path.join(root, name), content);
        }
        const result = await runPipelineFromRepo(root, () => {}, {});
        const targets = [...result.graph.iterRelationships()]
          .filter(
            (edge) =>
              edge.type === 'CALLS' &&
              result.graph.getNode(edge.sourceId)?.properties.name === caller &&
              result.graph.getNode(edge.targetId)?.properties.name === member,
          )
          .map((edge) => result.graph.getNode(edge.targetId)?.properties.filePath);
        expect(targets).toEqual([target]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    120000,
  );

  it('ranks the global type before a compilation-unit using in type references', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'csharp-type-reference-tier-'));
    try {
      await fs.writeFile(
        path.join(root, 'ABilling.cs'),
        'namespace Billing; public class RefVoucher {}',
      );
      await fs.writeFile(path.join(root, 'ZGlobal.cs'), 'public class RefVoucher {}');
      await fs.writeFile(
        path.join(root, 'Use.cs'),
        'using Billing;\npublic class Box<T> {}\npublic class Consumer { public Box<RefVoucher> field; }',
      );
      const result = await runPipelineFromRepo(root, () => {}, {});
      const targets = [...result.graph.iterRelationships()]
        .filter(
          (edge) =>
            edge.type === 'USES' &&
            result.graph.getNode(edge.sourceId)?.properties.filePath === 'Use.cs' &&
            result.graph.getNode(edge.targetId)?.properties.name === 'RefVoucher',
        )
        .map((edge) => result.graph.getNode(edge.targetId)?.properties.filePath);
      expect(targets).not.toEqual([]);
      expect(new Set(targets)).toEqual(new Set(['ZGlobal.cs']));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
