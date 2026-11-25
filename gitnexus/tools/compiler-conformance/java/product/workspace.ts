import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractJavaWorkspaceLinks } from '../../../../src/core/group/extractors/java-workspace-extractor.js';

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

    assert.equal(result.links.length, 1);
    assert.deepEqual(result.links[0], {
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

    assert.equal(result.discoveredProjects.size, 4);
    assert.equal(result.discoveredProjects.get('parent')?.artifactId, 'parent');
    assert.equal(result.discoveredProjects.get('shared-lib')?.artifactId, 'shared-lib');
    assert.equal(result.discoveredProjects.get('service-a')?.artifactId, 'service-a');
    assert.equal(result.discoveredProjects.get('service-b')?.artifactId, 'service-b');
    assert.deepEqual(result.links, [
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

  async function extractNamed(names: string[]) {
    return extractJavaWorkspaceLinks(
      Object.fromEntries(names.map((name) => [name, name])),
      new Map(names.map((name) => [name, path.join(tmpDir, name)])),
    );
  }

  it('ignores dependencyManagement, profiles, and plugin dependencies for workspace links', async () => {
    await writeFile('shared-lib/pom.xml', pomTemplate('com.example', 'shared-lib'));
    await writeFile(
      'shared-lib/src/main/java/com/example/shared/lib/SharedType.java',
      'package com.example.shared.lib;\npublic class SharedType {}\n',
    );

    await writeFile(
      'bom-consumer/pom.xml',
      `<project>
        <groupId>com.example</groupId>
        <artifactId>bom-consumer</artifactId>
        <dependencyManagement>
          <dependencies>
            <dependency>
              <groupId>com.example</groupId>
              <artifactId>shared-lib</artifactId>
              <version>1</version>
            </dependency>
          </dependencies>
        </dependencyManagement>
      </project>`,
    );
    await writeFile(
      'bom-consumer/src/main/java/com/example/bom/App.java',
      'package com.example.bom;\nimport com.example.shared.lib.SharedType;\npublic class App {}\n',
    );

    await writeFile(
      'profile-consumer/pom.xml',
      `<project>
        <groupId>com.example</groupId>
        <artifactId>profile-consumer</artifactId>
        <profiles>
          <profile>
            <id>extra</id>
            <dependencies>
              <dependency>
                <groupId>com.example</groupId>
                <artifactId>shared-lib</artifactId>
              </dependency>
            </dependencies>
          </profile>
        </profiles>
      </project>`,
    );
    await writeFile(
      'profile-consumer/src/main/kotlin/com/example/profile/App.kt',
      'package com.example.profile\nimport com.example.shared.lib.SharedType\nclass App\n',
    );

    await writeFile(
      'plugin-consumer/pom.xml',
      `<project>
        <groupId>com.example</groupId>
        <artifactId>plugin-consumer</artifactId>
        <build>
          <plugins>
            <plugin>
              <groupId>org.apache.maven.plugins</groupId>
              <artifactId>maven-compiler-plugin</artifactId>
              <dependencies>
                <dependency>
                  <groupId>com.example</groupId>
                  <artifactId>shared-lib</artifactId>
                </dependency>
              </dependencies>
            </plugin>
          </plugins>
        </build>
      </project>`,
    );
    await writeFile(
      'plugin-consumer/src/main/java/com/example/plugin/App.java',
      'package com.example.plugin;\nimport com.example.shared.lib.SharedType;\npublic class App {}\n',
    );

    const result = await extractNamed([
      'shared-lib',
      'bom-consumer',
      'profile-consumer',
      'plugin-consumer',
    ]);

    assert.deepEqual(result.discoveredProjects.get('bom-consumer')?.deps, []);
    assert.deepEqual(result.discoveredProjects.get('profile-consumer')?.deps, []);
    assert.deepEqual(result.discoveredProjects.get('plugin-consumer')?.deps, []);
    assert.deepEqual(result.links, []);
  });

  it('parses namespaced POM coordinates and CDATA text with a real XML parser', async () => {
    await writeFile(
      'lib/pom.xml',
      `<?xml version="1.0"?>
      <m:project xmlns:m="http://maven.apache.org/POM/4.0.0">
        <m:parent>
          <m:groupId>com.parent</m:groupId>
          <m:artifactId>parent</m:artifactId>
        </m:parent>
        <m:artifactId><![CDATA[shared-lib]]></m:artifactId>
        <m:dependencies>
          <m:dependency>
            <m:groupId>com.acme</m:groupId>
            <m:artifactId>models</m:artifactId>
          </m:dependency>
        </m:dependencies>
      </m:project>`,
    );
    await writeFile('models/pom.xml', pomTemplate('com.acme', 'models'));
    await writeFile(
      'models/src/main/java/com/acme/models/User.java',
      'package com.acme.models;\npublic class User {}\n',
    );
    await writeFile(
      'lib/src/main/java/com/parent/shared/lib/App.java',
      'package com.parent.shared.lib;\nimport com.acme.models.User;\npublic class App {}\n',
    );

    const result = await extractJavaWorkspaceLinks(
      { lib: 'lib', models: 'models' },
      new Map([
        ['lib', path.join(tmpDir, 'lib')],
        ['models', path.join(tmpDir, 'models')],
      ]),
    );

    assert.partialDeepStrictEqual(result.discoveredProjects.get('lib'), {
      groupId: 'com.parent',
      artifactId: 'shared-lib',
    });
    assert.deepEqual(result.links, [
      {
        from: 'models',
        to: 'lib',
        type: 'custom',
        contract: 'models::User',
        role: 'provider',
      },
    ]);
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

    assert.equal(result.links.length, 1);
    assert.equal(result.links[0].contract, 'core::Config');
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

    assert.equal(result.links.length, 1);
    assert.equal(result.links[0].contract, 'common::Entity');
  });

  it('reads Gradle group from gradle.properties and Groovy setter syntax', async () => {
    await writeFile('core/gradle.properties', 'group=com.acme\n');
    await writeFile('core/build.gradle', 'plugins { id "java" }\n');
    await writeFile(
      'core/src/main/java/com/acme/core/Config.java',
      'package com.acme.core;\npublic class Config {}\n',
    );

    await writeFile(
      'svc/build.gradle',
      "group 'com.acme'\ndependencies {\n  testImplementation 'com.acme:core:1.0'\n}\n",
    );
    await writeFile(
      'svc/src/test/kotlin/com/acme/svc/AppTest.kt',
      'package com.acme.svc\nimport com.acme.core.Config\nclass AppTest\n',
    );

    const result = await extractNamed(['core', 'svc']);

    assert.partialDeepStrictEqual(result.discoveredProjects.get('core'), {
      groupId: 'com.acme',
      artifactId: 'core',
    });
    assert.deepEqual(result.links, [
      {
        from: 'core',
        to: 'svc',
        type: 'custom',
        contract: 'core::Config',
        role: 'provider',
      },
    ]);
  });

  it('reads Gradle group assigned inside allprojects { }', async () => {
    await writeFile('core/build.gradle', 'allprojects { group = "com.acme" }\n');
    await writeFile(
      'core/src/main/java/com/acme/core/Config.java',
      'package com.acme.core;\npublic class Config {}\n',
    );
    await writeFile(
      'svc/build.gradle',
      'allprojects { group = "com.acme" }\ndependencies {\n  implementation "com.acme:core:1.0"\n}\n',
    );
    await writeFile(
      'svc/src/main/java/com/acme/svc/App.java',
      'package com.acme.svc;\nimport com.acme.core.Config;\npublic class App {}\n',
    );

    const result = await extractNamed(['core', 'svc']);

    assert.partialDeepStrictEqual(result.discoveredProjects.get('core'), {
      groupId: 'com.acme',
      artifactId: 'core',
    });
    assert.deepEqual(result.links, [
      {
        from: 'core',
        to: 'svc',
        type: 'custom',
        contract: 'core::Config',
        role: 'provider',
      },
    ]);
  });

  it('uses settings.gradle rootProject.name as the Gradle artifactId', async () => {
    await writeFile('checkout/settings.gradle.kts', 'rootProject.name = "shared-core"\n');
    await writeFile('checkout/build.gradle.kts', 'group = "com.acme"\n');
    await writeFile(
      'checkout/src/main/java/com/acme/shared/core/Flag.java',
      'package com.acme.shared.core;\npublic class Flag {}\n',
    );
    await writeFile(
      'app/build.gradle.kts',
      'group = "com.acme"\ndependencies {\n  implementation("com.acme:shared-core:1.0")\n}\n',
    );
    await writeFile(
      'app/src/main/kotlin/com/acme/app/Main.kt',
      'package com.acme.app\nimport com.acme.shared.core.Flag\nclass Main\n',
    );

    const result = await extractJavaWorkspaceLinks(
      { checkout: 'checkout', app: 'app' },
      new Map([
        ['checkout', path.join(tmpDir, 'checkout')],
        ['app', path.join(tmpDir, 'app')],
      ]),
    );

    assert.equal(result.discoveredProjects.get('checkout')?.artifactId, 'shared-core');
    assert.deepEqual(result.links, [
      {
        from: 'checkout',
        to: 'app',
        type: 'custom',
        contract: 'shared-core::Flag',
        role: 'provider',
      },
    ]);
  });

  it('resolves Gradle version-catalog and named group/name coordinates', async () => {
    await writeFile('shared-lib/build.gradle.kts', 'group = "com.example"\n');
    await writeFile(
      'shared-lib/src/main/java/com/example/shared/lib/SharedType.java',
      'package com.example.shared.lib;\npublic class SharedType {}\n',
    );
    await writeFile('models/build.gradle.kts', 'group = "com.example"\n');
    await writeFile(
      'models/src/main/java/com/example/models/User.java',
      'package com.example.models;\npublic class User {}\n',
    );

    await writeFile(
      'app/gradle/libs.versions.toml',
      `[libraries]
shared-lib = { module = "com.example:shared-lib", version = "1.0" }
models = { group = "com.example", name = "models", version.ref = "unused" }

[bundles]
workspace = ["shared-lib", "models"]
`,
    );
    await writeFile(
      'app/build.gradle.kts',
      `group = "com.example"
dependencies {
  implementation(libs.shared.lib)
  implementation(libs.bundles.workspace)
}
`,
    );
    await writeFile(
      'app/src/main/kotlin/com/example/app/App.kt',
      'package com.example.app\nimport com.example.shared.lib.SharedType\nimport com.example.models.User\nclass App\n',
    );

    await writeFile(
      'named/build.gradle',
      `group = 'com.example'
dependencies {
  implementation group: 'com.example', name: 'shared-lib', version: '1.0'
}
`,
    );
    await writeFile(
      'named-first/build.gradle',
      `group = 'com.example'
dependencies {
  implementation name: 'shared-lib', group: 'com.example', version: '1.0'
}
`,
    );
    await writeFile(
      'named/src/main/java/com/example/named/App.java',
      'package com.example.named;\nimport com.example.shared.lib.SharedType;\npublic class App {}\n',
    );
    await writeFile(
      'named-first/src/main/java/com/example/namedfirst/App.java',
      'package com.example.namedfirst;\nimport com.example.shared.lib.SharedType;\npublic class App {}\n',
    );

    const result = await extractNamed(['shared-lib', 'models', 'app', 'named', 'named-first']);

    const dependencies = result.discoveredProjects.get('app')?.deps;
    dependencies?.sort(compareCodeUnits);
    assert.deepEqual(dependencies, ['com.example:models', 'com.example:shared-lib']);
    for (const link of [
      {
        from: 'shared-lib',
        to: 'app',
        contract: 'shared-lib::SharedType',
      },
      { from: 'models', to: 'app', contract: 'models::User' },
      {
        from: 'shared-lib',
        to: 'named',
        contract: 'shared-lib::SharedType',
      },
      {
        from: 'shared-lib',
        to: 'named-first',
        contract: 'shared-lib::SharedType',
      },
    ])
      assert.ok(
        result.links.some(
          (actual) =>
            actual.from === link.from && actual.to === link.to && actual.contract === link.contract,
        ),
      );
    assert.equal(result.links.length, 4);
  });

  it('resolves version-catalog aliases that contain underscores', async () => {
    await writeFile('shared-lib/build.gradle.kts', 'group = "com.example"\n');
    await writeFile(
      'shared-lib/src/main/java/com/example/shared/lib/SharedType.java',
      'package com.example.shared.lib;\npublic class SharedType {}\n',
    );
    await writeFile(
      'app/gradle/libs.versions.toml',
      `[libraries]
foo_bar = { module = "com.example:shared-lib", version = "1.0" }
`,
    );
    await writeFile(
      'app/build.gradle.kts',
      `group = "com.example"
dependencies {
  implementation(libs.foo_bar)
}
`,
    );
    await writeFile(
      'app/src/main/kotlin/com/example/app/App.kt',
      'package com.example.app\nimport com.example.shared.lib.SharedType\nclass App\n',
    );

    const result = await extractNamed(['shared-lib', 'app']);

    assert.deepEqual(result.discoveredProjects.get('app')?.deps, ['com.example:shared-lib']);
    assert.equal(result.links.length, 1);
    assert.partialDeepStrictEqual(result.links[0], {
      from: 'shared-lib',
      to: 'app',
      contract: 'shared-lib::SharedType',
    });
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

    assert.partialDeepStrictEqual(result.discoveredProjects.get('gradle-app'), {
      groupId: 'com.example',
      artifactId: 'gradle-app',
    });
    assert.deepEqual(result.links, [
      {
        from: 'shared-lib',
        to: 'gradle-app',
        type: 'custom',
        contract: 'shared-lib::SharedType',
        role: 'provider',
      },
    ]);
  });

  it('links static member types and the owners of static fields and wildcard imports', async () => {
    const root = path.resolve(
      import.meta.dirname,
      '../../../../test/fixtures/compiler-conformance/java-workspace-static-imports',
    );
    const repos = { lib: 'lib', named: 'named', wildcard: 'wildcard' };
    const paths = new Map(Object.keys(repos).map((name) => [name, path.join(root, name)]));
    const result = await extractJavaWorkspaceLinks(repos, paths);
    assert.deepEqual(
      result.links
        .map((link) => [link.from, link.to, link.contract])
        .sort((a, b) => compareCodeUnits(a[1], b[1]) || compareCodeUnits(a[2], b[2])),
      [
        ['lib', 'named', 'lib::Constants'],
        ['lib', 'named', 'lib::Marker'],
        ['lib', 'named', 'lib::Token'],
        ['lib', 'wildcard', 'lib::Constants'],
      ],
    );
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

    assert.equal(result.links.length, 1);
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

    assert.equal(result.links.length, 2);
    const contracts = result.links.map((l) => l.contract).sort(compareCodeUnits);
    assert.deepEqual(contracts, ['lib::Request', 'lib::Response']);
  });
});
