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

  it('discovers cross-project imports via Maven pom.xml', async () => {
    await writeFile('models/pom.xml', pomTemplate('com.acme', 'models'));
    await writeFile(
      'models/src/main/java/com/acme/models/User.java',
      'package com.acme.models;\npublic class User {}\n',
    );

    await writeFile('api/pom.xml', pomTemplate('com.acme', 'api', ['com.acme:models']));
    await writeFile(
      'api/src/main/java/com/acme/api/UserService.java',
      'package com.acme.api;\nimport com.acme.models.User;\npublic class UserService {}\n',
    );

    const repos = { models: 'models', api: 'api' };
    const repoPaths = new Map([
      ['models', path.join(tmpDir, 'models')],
      ['api', path.join(tmpDir, 'api')],
    ]);

    const result = await extractJavaWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toEqual({
      from: 'models',
      to: 'api',
      type: 'custom',
      contract: 'models::User',
      role: 'provider',
    });
  });

  it('keeps child artifacts distinct when independent repositories share a Maven parent', async () => {
    await writeFile('parent/pom.xml', pomTemplate('com.example', 'parent'));
    await writeFile('shared-lib/pom.xml', inheritedPomTemplate('shared-lib'));
    await writeFile(
      'shared-lib/src/main/java/com/example/shared/lib/SharedType.java',
      'package com.example.shared.lib;\npublic class SharedType {}\n',
    );

    await writeFile(
      'service-a/pom.xml',
      inheritedPomTemplate('service-a', ['com.example:shared-lib']),
    );
    await writeFile(
      'service-a/src/main/java/com/example/service/a/App.java',
      'package com.example.service.a;\nimport com.example.shared.lib.SharedType;\npublic class App {}\n',
    );

    await writeFile(
      'service-b/pom.xml',
      inheritedPomTemplate('service-b', ['com.example:shared-lib']),
    );
    await writeFile(
      'service-b/src/main/kotlin/com/example/service/b/App.kt',
      'package com.example.service.b\nimport com.example.shared.lib.SharedType\nclass App\n',
    );

    const repos = {
      parent: 'parent',
      'shared-lib': 'shared-lib',
      'service-a': 'service-a',
      'service-b': 'service-b',
    };
    const repoPaths = new Map(
      Object.keys(repos).map((groupPath) => [groupPath, path.join(tmpDir, groupPath)]),
    );

    const result = await extractJavaWorkspaceLinks(repos, repoPaths);

    expect(result.discoveredProjects.size).toBe(4);
    expect(result.discoveredProjects.get('parent')?.artifactId).toBe('parent');
    expect(result.discoveredProjects.get('shared-lib')?.artifactId).toBe('shared-lib');
    expect(result.discoveredProjects.get('service-a')?.artifactId).toBe('service-a');
    expect(result.discoveredProjects.get('service-b')?.artifactId).toBe('service-b');
    expect(result.links).toEqual([
      {
        from: 'shared-lib',
        to: 'service-a',
        type: 'custom',
        contract: 'shared-lib::SharedType',
        role: 'provider',
      },
      {
        from: 'shared-lib',
        to: 'service-b',
        type: 'custom',
        contract: 'shared-lib::SharedType',
        role: 'provider',
      },
    ]);
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

  it('handles Gradle build files', async () => {
    await writeFile('core/build.gradle.kts', 'group = "com.acme"\nversion = "1.0"\n');
    await writeFile(
      'core/src/main/java/com/acme/core/Config.java',
      'package com.acme.core;\npublic class Config {}\n',
    );

    await writeFile(
      'svc/build.gradle.kts',
      'group = "com.acme"\nversion = "1.0"\ndependencies {\n  implementation("com.acme:core:1.0")\n}\n',
    );
    await writeFile(
      'svc/src/main/kotlin/com/acme/svc/App.kt',
      'package com.acme.svc\nimport com.acme.core.Config\nclass App\n',
    );

    const repos = { core: 'core', svc: 'svc' };
    const repoPaths = new Map([
      ['core', path.join(tmpDir, 'core')],
      ['svc', path.join(tmpDir, 'svc')],
    ]);

    const result = await extractJavaWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('core::Config');
  });

  it('handles Gradle project dependencies', async () => {
    await writeFile('common/build.gradle', "group = 'com.org'\nversion = '1.0'\n");
    await writeFile(
      'common/src/main/java/com/org/common/Entity.java',
      'package com.org.common;\npublic class Entity {}\n',
    );

    await writeFile(
      'app/build.gradle',
      "group = 'com.org'\nversion = '1.0'\ndependencies {\n  implementation(project(':common'))\n}\n",
    );
    await writeFile(
      'app/src/main/java/com/org/app/Main.java',
      'package com.org.app;\nimport com.org.common.Entity;\npublic class Main {}\n',
    );

    const repos = { common: 'common', app: 'app' };
    const repoPaths = new Map([
      ['common', path.join(tmpDir, 'common')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractJavaWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('common::Entity');
  });

  it('discovers Maven and Gradle projects together without changing Gradle identity', async () => {
    await writeFile('shared-lib/pom.xml', pomTemplate('com.example', 'shared-lib'));
    await writeFile(
      'shared-lib/src/main/java/com/example/shared/lib/SharedType.java',
      'package com.example.shared.lib;\npublic class SharedType {}\n',
    );
    await writeFile(
      'gradle-app/build.gradle.kts',
      'group = "com.example"\ndependencies {\n  implementation("com.example:shared-lib:1.0")\n}\n',
    );
    await writeFile(
      'gradle-app/src/main/kotlin/com/example/gradle/app/App.kt',
      'package com.example.gradle.app\nimport com.example.shared.lib.SharedType\nclass App\n',
    );

    const result = await extractJavaWorkspaceLinks(
      { 'shared-lib': 'shared-lib', 'gradle-app': 'gradle-app' },
      new Map([
        ['shared-lib', path.join(tmpDir, 'shared-lib')],
        ['gradle-app', path.join(tmpDir, 'gradle-app')],
      ]),
    );

    expect(result.discoveredProjects.get('gradle-app')).toMatchObject({
      groupId: 'com.example',
      artifactId: 'gradle-app',
    });
    expect(result.links).toEqual([
      {
        from: 'shared-lib',
        to: 'gradle-app',
        type: 'custom',
        contract: 'shared-lib::SharedType',
        role: 'provider',
      },
    ]);
  });

  it('handles static imports', async () => {
    await writeFile('lib/pom.xml', pomTemplate('com.acme', 'lib'));
    await writeFile(
      'lib/src/main/java/com/acme/lib/Constants.java',
      'package com.acme.lib;\npublic class Constants {}\n',
    );

    await writeFile('app/pom.xml', pomTemplate('com.acme', 'app', ['com.acme:lib']));
    await writeFile(
      'app/src/main/java/com/acme/app/Main.java',
      'package com.acme.app;\nimport static com.acme.lib.Constants;\npublic class Main {}\n',
    );

    const repos = { lib: 'lib', app: 'app' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractJavaWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
    expect(result.links[0].contract).toBe('lib::Constants');
  });

  it('skips repos without Java manifest', async () => {
    await writeFile('rs-app/Cargo.toml', '[package]\nname = "rapp"\n');

    const repos = { app: 'rapp' };
    const repoPaths = new Map([['app', path.join(tmpDir, 'rs-app')]]);

    const result = await extractJavaWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(0);
    expect(result.discoveredProjects.size).toBe(0);
  });

  it('deduplicates identical imports from multiple files', async () => {
    await writeFile('lib/pom.xml', pomTemplate('com.acme', 'lib'));
    await writeFile(
      'lib/src/main/java/com/acme/lib/Token.java',
      'package com.acme.lib;\npublic class Token {}\n',
    );

    await writeFile('app/pom.xml', pomTemplate('com.acme', 'app', ['com.acme:lib']));
    await writeFile(
      'app/src/main/java/com/acme/app/A.java',
      'package com.acme.app;\nimport com.acme.lib.Token;\npublic class A {}\n',
    );
    await writeFile(
      'app/src/main/java/com/acme/app/B.java',
      'package com.acme.app;\nimport com.acme.lib.Token;\npublic class B {}\n',
    );

    const repos = { lib: 'lib', app: 'app' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractJavaWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(1);
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

  it('discovers multiple types from the same dependency', async () => {
    await writeFile('lib/pom.xml', pomTemplate('com.acme', 'lib'));
    await writeFile(
      'lib/src/main/java/com/acme/lib/Request.java',
      'package com.acme.lib;\npublic class Request {}\n',
    );
    await writeFile(
      'lib/src/main/java/com/acme/lib/Response.java',
      'package com.acme.lib;\npublic class Response {}\n',
    );

    await writeFile('app/pom.xml', pomTemplate('com.acme', 'app', ['com.acme:lib']));
    await writeFile(
      'app/src/main/java/com/acme/app/Handler.java',
      'package com.acme.app;\nimport com.acme.lib.Request;\nimport com.acme.lib.Response;\npublic class Handler {}\n',
    );

    const repos = { lib: 'lib', app: 'app' };
    const repoPaths = new Map([
      ['lib', path.join(tmpDir, 'lib')],
      ['app', path.join(tmpDir, 'app')],
    ]);

    const result = await extractJavaWorkspaceLinks(repos, repoPaths);

    expect(result.links).toHaveLength(2);
    const contracts = result.links.map((l) => l.contract).sort();
    expect(contracts).toEqual(['lib::Request', 'lib::Response']);
  });
});
