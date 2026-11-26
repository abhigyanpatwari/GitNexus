import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractJavaWorkspaceLinks } from '../../../src/core/group/extractors/java-workspace-extractor.js';

describe('JavaWorkspaceExtractor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-java-ws-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(relPath: string, content: string) {
    const absPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
  }

  const pomTemplate = (g: string, a: string, deps: string[] = []) => {
    const depXml = deps
      .map((d) => {
        const [gid, aid] = d.split(':');
        return `<dependency><groupId>${gid}</groupId><artifactId>${aid}</artifactId></dependency>`;
      })
      .join('\n');
    return `<project><groupId>${g}</groupId><artifactId>${a}</artifactId><dependencies>${depXml}</dependencies></project>`;
  };

  const inheritedPomTemplate = (artifactId: string, deps: string[] = []) => {
    const depXml = deps
      .map((d) => {
        const [gid, aid] = d.split(':');
        return `<dependency><groupId>${gid}</groupId><artifactId>${aid}</artifactId></dependency>`;
      })
      .join('\n');
    return `<project xmlns="http://maven.apache.org/POM/4.0.0">
      <parent>
        <groupId>com.example</groupId>
        <artifactId>parent</artifactId>
        <version>1</version>
      </parent>
      <artifactId>${artifactId}</artifactId>
      <dependencies>${depXml}</dependencies>
    </project>`;
  };

  async function extractNamed(names: string[]) {
    return extractJavaWorkspaceLinks(
      Object.fromEntries(names.map((name) => [name, name])),
      new Map(names.map((name) => [name, path.join(tmpDir, name)])),
    );
  }

  it('skips POMs that cannot yield a child artifact identity', async () => {
    await writeFile('broken/pom.xml', '<project><unclosed');
    await writeFile('not-maven/pom.xml', '<notproject></notproject>');
    await writeFile('empty/pom.xml', '<project></project>');
    await writeFile(
      'parent-only/pom.xml',
      `<project>
        <parent>
          <groupId>com.example</groupId>
          <artifactId>parent</artifactId>
          <version>1</version>
        </parent>
      </project>`,
    );
    await writeFile('no-group/pom.xml', '<project><artifactId>orphan</artifactId></project>');

    const result = await extractNamed(['broken', 'not-maven', 'empty', 'parent-only', 'no-group']);

    expect(result.discoveredProjects.size).toBe(0);
    expect(result.links).toHaveLength(0);
    expect(result.discoveredProjects.has('parent-only')).toBe(false);
  });

  it('uses an explicit child groupId instead of its Maven parent groupId', async () => {
    await writeFile(
      'service/pom.xml',
      `<project>
        <parent>
          <groupId>com.parent</groupId>
          <artifactId>parent</artifactId>
          <version>1</version>
        </parent>
        <groupId>com.child</groupId>
        <artifactId>service</artifactId>
      </project>`,
    );

    const result = await extractJavaWorkspaceLinks(
      { service: 'service' },
      new Map([['service', path.join(tmpDir, 'service')]]),
    );

    expect(result.discoveredProjects.get('service')).toMatchObject({
      groupId: 'com.child',
      artifactId: 'service',
    });
  });

  it('still rejects genuinely duplicate effective Maven coordinates', async () => {
    await writeFile('first/pom.xml', inheritedPomTemplate('shared-lib'));
    await writeFile('second/pom.xml', inheritedPomTemplate('shared-lib'));

    const result = await extractJavaWorkspaceLinks(
      { first: 'first', second: 'second' },
      new Map([
        ['first', path.join(tmpDir, 'first')],
        ['second', path.join(tmpDir, 'second')],
      ]),
    );

    expect(result.discoveredProjects.size).toBe(1);
    expect(result.discoveredProjects.has('first')).toBe(true);
    expect(result.discoveredProjects.has('second')).toBe(false);
  });

  it('resolves Kotlin DSL named args, catalog get(), and type-safe project accessors', async () => {
    await writeFile('shared-lib/build.gradle.kts', 'group = "com.example"\n');
    await writeFile(
      'shared-lib/src/main/kotlin/com/example/shared/lib/SharedType.kt',
      'package com.example.shared.lib\nclass SharedType\n',
    );
    await writeFile('models/build.gradle.kts', 'group = "com.example"\n');
    await writeFile(
      'models/src/main/kotlin/com/example/models/User.kt',
      'package com.example.models\ndata class User(val id: Int)\n',
    );

    await writeFile(
      'app/gradle/libs.versions.toml',
      '[libraries]\nmodels = { group = "com.example", name = "models" }\n',
    );
    await writeFile(
      'app/build.gradle.kts',
      `group = "com.example"
kotlin {
  sourceSets {
    commonMain {
      dependencies {
        implementation(name = "shared-lib", group = "com.example", version = "1.0")
        implementation(projects.sharedLib)
        implementation(libs.models.get())
        ksp(libs.models)
      }
    }
  }
}
`,
    );
    await writeFile(
      'app/src/commonMain/kotlin/com/example/app/App.kt',
      'package com.example.app\nimport com.example.shared.lib.SharedType as ST\nimport com.example.models.User\nclass App(val user: User, val shared: ST)\n',
    );

    const result = await extractNamed(['shared-lib', 'models', 'app']);

    expect(result.discoveredProjects.get('app')?.deps.sort()).toEqual([
      'com.example:models',
      'com.example:shared-lib',
    ]);
    expect(result.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'shared-lib',
          to: 'app',
          contract: 'shared-lib::SharedType',
        }),
        expect.objectContaining({ from: 'models', to: 'app', contract: 'models::User' }),
      ]),
    );
    expect(result.links).toHaveLength(2);
  });

  it('skips repos without Java manifest', async () => {
    await writeFile('rs-app/Cargo.toml', '[package]\nname = "rapp"\n');

    const repos = { app: 'rapp' };
    const repoPaths = new Map([['app', path.join(tmpDir, 'rs-app')]]);

    const result = await extractJavaWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(0);
    expect(result.discoveredProjects.size).toBe(0);
  });

  it('discovers Kotlin file imports from Java projects', async () => {
    await writeFile('lib/pom.xml', pomTemplate('com.acme', 'lib'));
    await writeFile(
      'lib/src/main/kotlin/com/acme/lib/Model.kt',
      'package com.acme.lib\ndata class Model(val id: Int)\n',
    );

    await writeFile('app/pom.xml', pomTemplate('com.acme', 'app', ['com.acme:lib']));
    await writeFile(
      'app/src/main/kotlin/com/acme/app/Main.kt',
      'package com.acme.app\nimport com.acme.lib.Model\nfun main() {}\n',
    );

    const repos = { lib: 'lib', app: 'app' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractJavaWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('lib::Model');
  });
});
