import { compareSpringJava } from '../spring-web-java.mjs';
import { springProject } from '../spring-support.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
export async function verifyActuatorRuntime() {
  const SECRET_ENV_VALUE = 'ACTUATOR_ENV_SECRET_2418';
  const SECRET_CONFIG_VALUE = 'ACTUATOR_CONFIG_SECRET_2418';
  const SECRET_CONDITION_MESSAGE = 'runtime condition details must stay private';
  function writeFixture(root, relativePath, content) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), {
      recursive: true,
    });
    fs.writeFileSync(target, content);
  }
  function writeJson(root, relativePath, value) {
    writeFixture(root, relativePath, JSON.stringify(value));
  }
  function runtimeFixture() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-'));
    tempRepos.push(repo);
    fs.cpSync(springProject('actuator'), repo, {
      recursive: true,
    });
    writeFixture(
      repo,
      'src/main/resources/application.properties',
      'app.billing.enabled=true\napp.billing.url=https://static.example\n',
    );
    const actuatorDir = path.join(repo, 'runtime-actuator');
    writeJson(repo, 'runtime-actuator/mappings.json', {
      contexts: {
        application: {
          mappings: {
            dispatcherServlets: {
              dispatcherServlet: [
                {
                  predicate: '{GET [/orders]}',
                  details: {
                    handlerMethod: {
                      className: 'com.example.OrderController',
                      name: 'list',
                      descriptor: '()Ljava/lang/String;',
                    },
                    requestMappingConditions: {
                      methods: ['GET'],
                      patterns: ['/orders'],
                    },
                  },
                },
                {
                  predicate: '{GET [/runtime-bound]}',
                  details: {
                    handlerMethod: {
                      className: 'com.example.OrderController',
                      name: 'list',
                      descriptor: '()Ljava/lang/String;',
                    },
                    requestMappingConditions: {
                      methods: ['GET'],
                      patterns: ['/runtime-bound'],
                    },
                  },
                },
                {
                  predicate: '{POST [/runtime-only]}',
                  details: {
                    handlerMethod: {
                      className: 'com.vendor.RuntimeController',
                      name: 'create',
                      descriptor: '()V',
                    },
                    requestMappingConditions: {
                      methods: ['POST'],
                      patterns: ['/runtime-only'],
                    },
                  },
                },
                {
                  predicate: '{GET [/runtime-overload]}',
                  details: {
                    handlerMethod: {
                      className: 'com.example.OrderController',
                      name: 'lookup',
                      descriptor: '(Ljava/lang/String;)Ljava/lang/String;',
                    },
                    requestMappingConditions: {
                      methods: ['GET'],
                      patterns: ['/runtime-overload'],
                    },
                  },
                },
                {
                  predicate: '{GET [/runtime-varargs]}',
                  details: {
                    handlerMethod: {
                      className: 'com.example.OrderController',
                      name: 'tags',
                      descriptor: '([Ljava/lang/String;)Ljava/lang/String;',
                    },
                    requestMappingConditions: {
                      methods: ['GET'],
                      patterns: ['/runtime-varargs'],
                    },
                  },
                },
                {
                  predicate: '{ [/GET]}',
                  details: {
                    handlerMethod: {
                      className: 'com.vendor.RuntimeController',
                      name: 'create',
                      descriptor: '()V',
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
    writeJson(repo, 'runtime-actuator/beans.json', {
      contexts: {
        application: {
          beans: {
            billingService: {
              type: 'com.example.BillingService',
              scope: 'singleton',
              dependencies: [],
            },
            runtimeOnlyBean: {
              type: 'com.vendor.RuntimeOnlyBean',
              scope: 'singleton',
              dependencies: [],
            },
          },
        },
      },
    });
    writeJson(repo, 'runtime-actuator/conditions.json', {
      contexts: {
        application: {
          positiveMatches: {
            'com.example.RuntimeConfig#billingService': [
              {
                condition: 'OnPropertyCondition',
                message: SECRET_CONDITION_MESSAGE,
              },
            ],
            'com.example.RuntimeConfig': [
              {
                condition: 'OnClassCondition',
                message: 'runtime configuration matched',
              },
            ],
          },
          negativeMatches: {},
        },
      },
    });
    writeJson(repo, 'runtime-actuator/configprops.json', {
      contexts: {
        application: {
          beans: {
            billing: {
              prefix: 'app.billing',
              properties: {
                url: SECRET_CONFIG_VALUE,
              },
              inputs: {
                url: {
                  value: SECRET_CONFIG_VALUE,
                  origin: 'systemEnvironment',
                },
                enabled: {
                  value: true,
                },
              },
            },
          },
        },
      },
    });
    writeJson(repo, 'runtime-actuator/env.json', {
      activeProfiles: [],
      propertySources: [
        {
          name: 'systemEnvironment',
          properties: {
            'app.billing.url': {
              value: SECRET_ENV_VALUE,
              origin: 'env',
            },
            'db.password': {
              value: SECRET_ENV_VALUE,
              origin: 'env',
            },
          },
        },
      ],
    });
    return {
      repo,
      actuatorDir,
    };
  }
  // Spring Boot Actuator runtime enrichment (#2418)

  const tempRepos = [];
  // is disabled by default and does not add runtime evidence
  function removeTemporaryProjects() {
    for (const repo of tempRepos.splice(0))
      fs.rmSync(repo, {
        recursive: true,
        force: true,
      });
  }
  try {
    const { repo } = runtimeFixture();
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
    });
    const oracle = compareSpringJava(repo, result);
    assert.equal(oracle.sites.length, 2, 'javac selects list -> helper -> leaf');
    assert.equal(
      [...result.graph.iterNodes()].some(
        (node) => node.properties.runtimeSource === 'spring-actuator',
      ),
      false,
    );
    assert.equal(
      [...result.graph.iterRelationships()].some((edge) =>
        edge.reason.startsWith('spring-actuator:'),
      ),
      false,
    );
  } finally {
    removeTemporaryProjects();
  }
  // confirms static routes/beans/properties, adds runtime-only evidence, and drops values

  try {
    const { repo, actuatorDir } = runtimeFixture();
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: actuatorDir,
    });
    const nodes = [...result.graph.iterNodes()];
    const nodeNamed = (name, label) =>
      nodes.find(
        (node) => node.properties.name === name && (label === undefined || node.label === label),
      );
    assert.partialDeepStrictEqual(nodeNamed('/orders', 'Route')?.properties, {
      method: 'GET',
      runtimeConfirmed: true,
      runtimeSource: 'spring-actuator',
    });
    assert.partialDeepStrictEqual(nodeNamed('/runtime-only', 'Route')?.properties, {
      method: 'POST',
      runtimeConfirmed: true,
    });
    assert.equal(nodeNamed('/GET', 'Route')?.properties.method, undefined);
    assert.equal(nodeNamed('/GET', 'Route')?.properties.runtimeConfirmed, true);
    const owner = nodeNamed('OrderController', 'Class');
    const ownerMethodId = [...result.graph.iterRelationshipsByType('HAS_METHOD')].find(
      (edge) =>
        edge.sourceId === owner?.id &&
        result.graph.getNode(edge.targetId)?.properties.name === 'list',
    )?.targetId;
    assert.equal(nodeNamed('/runtime-bound', 'Route')?.properties.handlerSymbolId, ownerMethodId);
    const overloadHandler = result.graph.getNode(
      String(nodeNamed('/runtime-overload', 'Route')?.properties.handlerSymbolId),
    );
    assert.equal(overloadHandler?.properties.name, 'lookup');
    assert.deepEqual(overloadHandler?.properties.parameterTypes, ['String']);
    const varargsHandler = result.graph.getNode(
      String(nodeNamed('/runtime-varargs', 'Route')?.properties.handlerSymbolId),
    );
    assert.equal(varargsHandler?.properties.name, 'tags');
    assert.deepEqual(varargsHandler?.properties.parameterTypes, ['String']);
    assert.equal(nodeNamed('BillingService', 'Class')?.properties.runtimeConfirmed, undefined);
    assert.ok(
      nodeNamed('BillingService', 'Class')?.properties.description.includes(
        'Spring Actuator beans runtime-confirmed',
      ),
    );
    assert.equal(
      nodeNamed('runtimeOnlyBean', 'CodeElement')?.properties.runtimeConfirmed,
      undefined,
    );
    assert.ok(
      nodeNamed('runtimeOnlyBean', 'CodeElement')?.properties.description.includes(
        'Spring Actuator beans runtime-confirmed',
      ),
    );
    const configOwner = nodeNamed('RuntimeConfig', 'Class');
    assert.ok(configOwner?.properties.description?.includes('Spring Actuator conditions matched'));
    const configMethodId = [...result.graph.iterRelationshipsByType('HAS_METHOD')].find(
      (edge) =>
        edge.sourceId === configOwner?.id &&
        result.graph.getNode(edge.targetId)?.properties.name === 'billingService',
    )?.targetId;
    assert.equal(result.graph.getNode(configMethodId ?? '')?.properties.runtimeStatus, undefined);
    assert.ok(
      result.graph
        .getNode(configMethodId ?? '')
        ?.properties.description.includes('Spring Actuator conditions matched'),
    );
    const siblingOwner = nodeNamed('SiblingConfig', 'Class');
    const siblingMethodId = [...result.graph.iterRelationshipsByType('HAS_METHOD')].find(
      (edge) =>
        edge.sourceId === siblingOwner?.id &&
        result.graph.getNode(edge.targetId)?.properties.name === 'billingService',
    )?.targetId;
    assert.equal(result.graph.getNode(siblingMethodId ?? '')?.properties.runtimeStatus, undefined);
    assert.equal(nodeNamed('app.billing.url', 'Property')?.properties.runtimeConfirmed, undefined);
    assert.ok(
      nodeNamed('app.billing.url', 'Property')?.properties.description.includes(
        'Spring Actuator configprops runtime-confirmed',
      ),
    );
    assert.equal(nodeNamed('db.password', 'Property')?.properties.runtimeConfirmed, undefined);
    assert.ok(
      nodeNamed('db.password', 'Property')?.properties.description.includes(
        'Spring Actuator env runtime-confirmed',
      ),
    );
    const graphText = JSON.stringify({
      nodes,
      relationships: [...result.graph.iterRelationships()],
    });
    assert.ok(!graphText.includes(SECRET_ENV_VALUE));
    assert.ok(!graphText.includes(SECRET_CONFIG_VALUE));
    assert.ok(!graphText.includes(SECRET_CONDITION_MESSAGE));
    assert.ok(!graphText.includes('systemEnvironment'));

    // The configured snapshot directory is excluded before source ingestion,
    // so env/configprops values cannot leak into File-node content or FTS.
    assert.equal(
      nodes.some((node) => String(node.properties.filePath).includes('runtime-actuator/')),
      false,
    );
    assert.equal(
      [...result.graph.iterRelationshipsByType('DECLARES')].some((edge) =>
        edge.reason.startsWith('spring-actuator:mappings:'),
      ),
      true,
    );
  } finally {
    removeTemporaryProjects();
  }
  // does not runtime-confirm a named provider whose declared type disagrees

  try {
    const { repo, actuatorDir } = runtimeFixture();
    writeJson(repo, 'runtime-actuator/beans.json', {
      contexts: {
        application: {
          beans: {
            billingService: {
              type: 'com.vendor.StaleBillingService',
              scope: 'singleton',
              dependencies: [],
            },
          },
        },
      },
    });
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: actuatorDir,
    });
    const nodes = [...result.graph.iterNodes()];
    const declaredProvider = nodes.find(
      (node) =>
        node.properties.name === 'billingService' && node.properties.springDiProvider !== undefined,
    );
    assert.equal(
      declaredProvider?.properties.description?.includes('Spring Actuator beans runtime-confirmed'),
      false,
    );
    assert.equal(
      nodes.some(
        (node) =>
          node.properties.name === 'billingService' &&
          node.properties.qualifiedName === 'com.vendor.StaleBillingService' &&
          String(node.properties.description).includes('Spring Actuator beans runtime-confirmed'),
      ),
      true,
    );
  } finally {
    removeTemporaryProjects();
  }
  // reports invalid JSON without echoing payload source text

  try {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-invalid-'));
    tempRepos.push(repo);
    writeFixture(repo, 'index.ts', 'export const value = 1;\n');
    writeFixture(repo, 'actuator/env.json', `{"value":"${SECRET_ENV_VALUE}`);
    await assert.rejects(
      runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        springActuatorPath: 'actuator',
      }),
      (error) =>
        error instanceof Error &&
        error.message.includes('not valid JSON') &&
        !error.message.includes(SECRET_ENV_VALUE),
    );
  } finally {
    removeTemporaryProjects();
  }
  // accepts a bundle file and excludes that file from source ingestion

  try {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-bundle-'));
    tempRepos.push(repo);
    writeFixture(repo, 'index.ts', 'export const value = 1;\n');
    writeJson(repo, 'runtime-snapshot.json', {
      env: {
        propertySources: [
          {
            name: 'bundle-source',
            properties: {
              'bundle.secret-key': {
                value: SECRET_ENV_VALUE,
              },
            },
          },
        ],
      },
    });
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: 'runtime-snapshot.json',
    });
    const nodes = [...result.graph.iterNodes()];
    assert.ok(
      nodes
        .find((node) => node.label === 'Property' && node.properties.name === 'bundle.secret-key')
        ?.properties.description.includes('Spring Actuator env runtime-confirmed'),
    );
    assert.equal(
      nodes.some((node) => node.properties.filePath === 'runtime-snapshot.json'),
      false,
    );
    assert.ok(!JSON.stringify(nodes).includes(SECRET_ENV_VALUE));
    assert.ok(!JSON.stringify(nodes).includes('bundle-source'));
  } finally {
    removeTemporaryProjects();
  }
  // keeps repository sources when the Actuator directory is the repository root

  try {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-root-'));
    tempRepos.push(repo);
    writeFixture(repo, 'index.ts', 'export const retained = true;\n');
    writeJson(repo, 'mappings.json', {
      contexts: {},
    });
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: repo,
    });
    const files = [...result.graph.iterNodes()].filter((node) => node.label === 'File');
    assert.equal(
      files.some((node) => node.properties.filePath === 'index.ts'),
      true,
    );
    assert.equal(
      files.some((node) => node.properties.filePath === 'mappings.json'),
      false,
    );
  } finally {
    removeTemporaryProjects();
  }
  // keeps repository sources when the Actuator directory is an ancestor

  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-parent-'));
    tempRepos.push(parent);
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(repo);
    writeFixture(repo, 'index.ts', 'export const retained = true;\n');
    writeJson(parent, 'mappings.json', {
      contexts: {},
    });
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: parent,
    });
    assert.equal(
      [...result.graph.iterNodes()].some(
        (node) => node.label === 'File' && node.properties.filePath === 'index.ts',
      ),
      true,
    );
  } finally {
    removeTemporaryProjects();
  }
  // excludes an in-repo Actuator dump addressed through a directory symlink
  if (!(process.platform === 'win32')) {
    try {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-symlink-'));
      tempRepos.push(repo);
      writeFixture(repo, 'index.ts', 'export const retained = true;\n');
      writeJson(repo, 'runtime-dumps/env.json', {
        propertySources: [
          {
            name: 'systemEnvironment',
            properties: {
              'symlink.secret': {
                value: SECRET_ENV_VALUE,
              },
            },
          },
        ],
      });
      fs.symlinkSync('runtime-dumps', path.join(repo, 'actuator'), 'dir');
      const result = await runPipelineFromRepo(repo, () => {}, {
        skipGraphPhases: true,
        springActuatorPath: 'actuator',
      });
      const nodes = [...result.graph.iterNodes()];
      assert.equal(
        nodes.some(
          (node) => node.label === 'Property' && node.properties.name === 'symlink.secret',
        ),
        true,
      );
      assert.equal(
        nodes.some((node) => node.properties.filePath === 'runtime-dumps/env.json'),
        false,
      );
      assert.ok(!JSON.stringify(nodes).includes(SECRET_ENV_VALUE));
    } finally {
      removeTemporaryProjects();
    }
  } // links an Actuator-only route with a resolved source handler to its execution flow
  try {
    const { repo, actuatorDir } = runtimeFixture();
    const result = await runPipelineFromRepo(repo, () => {}, {
      springActuatorPath: actuatorDir,
    });
    const route = [...result.graph.iterNodes()].find(
      (node) => node.label === 'Route' && node.properties.name === '/runtime-bound',
    );
    const entryEdges = [...result.graph.iterRelationshipsByType('ENTRY_POINT_OF')].filter(
      (edge) => edge.sourceId === route?.id,
    );
    assert.equal(typeof route?.properties.handlerSymbolId, 'string');
    assert.ok(entryEdges.length > 0);
    assert.equal(
      entryEdges.some(
        (edge) =>
          result.graph.getNode(edge.targetId)?.properties.entryPointId ===
          route?.properties.handlerSymbolId,
      ),
      true,
    );
  } finally {
    removeTemporaryProjects();
  }
  // keeps triple duplicate simple names ambiguous and rejects stale qualified packages

  try {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-actuator-ambiguous-'));
    tempRepos.push(repo);
    for (const pkg of ['one', 'two', 'three']) {
      writeFixture(
        repo,
        `src/main/java/${pkg}/DuplicateController.java`,
        `package ${pkg}; class DuplicateController { String run() { return "${pkg}"; } }\n`,
      );
    }
    writeFixture(
      repo,
      'src/main/java/source/AdminController.java',
      'package source; class AdminController { String run() { return "source"; } }\n',
    );
    writeJson(repo, 'actuator/mappings.json', {
      contexts: {
        application: {
          mappings: {
            dispatcherServlets: {
              dispatcherServlet: [
                {
                  predicate: '{GET [/ambiguous]}',
                  details: {
                    handlerMethod: {
                      className: 'DuplicateController',
                      name: 'run',
                      descriptor: '()Ljava/lang/String;',
                    },
                    requestMappingConditions: {
                      methods: ['GET'],
                      patterns: ['/ambiguous'],
                    },
                  },
                },
                {
                  predicate: '{GET [/stale-package]}',
                  details: {
                    handlerMethod: {
                      className: 'runtime.AdminController',
                      name: 'run',
                      descriptor: '()Ljava/lang/String;',
                    },
                    requestMappingConditions: {
                      methods: ['GET'],
                      patterns: ['/stale-package'],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: 'actuator',
    });
    const routes = [...result.graph.iterNodes()].filter((node) => node.label === 'Route');
    assert.equal(
      Object.hasOwn(
        routes.find((node) => node.properties.name === '/ambiguous')?.properties,
        'handlerSymbolId',
      ),
      false,
    );
    assert.equal(
      Object.hasOwn(
        routes.find((node) => node.properties.name === '/stale-package')?.properties,
        'handlerSymbolId',
      ),
      false,
    );
  } finally {
    removeTemporaryProjects();
  }
  // records a static/runtime handler conflict without confirming the wrong owner

  try {
    const { repo } = runtimeFixture();
    writeFixture(
      repo,
      'src/main/java/com/example/OtherController.java',
      'package com.example; class OtherController { String otherList() { return "other"; } }\n',
    );
    writeJson(repo, 'runtime-actuator/mappings.json', {
      contexts: {
        application: {
          mappings: {
            dispatcherServlets: {
              dispatcherServlet: [
                {
                  predicate: '{GET [/orders]}',
                  details: {
                    handlerMethod: {
                      className: 'com.example.OtherController',
                      name: 'otherList',
                      descriptor: '()Ljava/lang/String;',
                    },
                    requestMappingConditions: {
                      methods: ['GET'],
                      patterns: ['/orders'],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: 'runtime-actuator',
    });
    const route = [...result.graph.iterNodes()].find(
      (node) => node.label === 'Route' && node.properties.name === '/orders',
    );
    const otherFile = [...result.graph.iterNodes()].find(
      (node) => node.label === 'File' && node.properties.filePath.endsWith('OtherController.java'),
    );
    assert.ok(route?.properties.filePath?.includes('RuntimeApplication.java'));
    assert.notEqual(
      route?.properties.handlerSymbolId,
      [...result.graph.iterNodes()].find(
        (node) =>
          node.label === 'Method' &&
          node.properties.name === 'otherList' &&
          node.properties.filePath.endsWith('OtherController.java'),
      )?.id,
    );
    assert.partialDeepStrictEqual(route?.properties, {
      runtimeConfirmed: false,
      runtimeSource: 'spring-actuator',
      runtimeStatus: 'handler-conflict',
    });
    assert.equal(
      [...result.graph.iterRelationshipsByType('HANDLES_ROUTE')].some(
        (edge) => edge.sourceId === otherFile?.id && edge.targetId === route?.id,
      ),
      false,
    );
  } finally {
    removeTemporaryProjects();
  }
  // marks duplicate runtime mappings with different handlers as a conflict

  try {
    const { repo } = runtimeFixture();
    const mapping = (className) => ({
      predicate: '{GET [/context-conflict]}',
      details: {
        handlerMethod: {
          className,
          name: 'list',
          descriptor: '()Ljava/lang/String;',
        },
        requestMappingConditions: {
          methods: ['GET'],
          patterns: ['/context-conflict'],
        },
      },
    });
    writeJson(repo, 'runtime-actuator/mappings.json', {
      contexts: {
        parent: {
          mappings: {
            dispatcherServlets: {
              dispatcherServlet: [mapping('com.example.OrderController')],
            },
          },
        },
        child: {
          mappings: {
            dispatcherServlets: {
              dispatcherServlet: [mapping('com.example.SiblingController')],
            },
          },
        },
      },
    });
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: 'runtime-actuator',
    });
    const route = [...result.graph.iterNodes()].find(
      (node) => node.label === 'Route' && node.properties.name === '/context-conflict',
    );
    assert.partialDeepStrictEqual(route?.properties, {
      runtimeConfirmed: false,
      runtimeSource: 'spring-actuator',
      runtimeStatus: 'handler-conflict',
    });
    assert.equal(Object.hasOwn(route?.properties, 'handlerSymbolId'), false);
    assert.equal(
      [...result.graph.iterRelationshipsByType('HANDLES_ROUTE')].some(
        (edge) => edge.targetId === route?.id,
      ),
      false,
    );
  } finally {
    removeTemporaryProjects();
  }
  // keeps aggregate negative condition status on the owner instead of every child target

  try {
    const { repo } = runtimeFixture();
    writeJson(repo, 'runtime-actuator/conditions.json', {
      contexts: {
        application: {
          positiveMatches: {},
          negativeMatches: {
            'com.example.RuntimeConfig#billingService': {
              notMatched: [
                {
                  condition: 'OnPropertyCondition',
                  message: 'did not match',
                },
              ],
              matched: [
                {
                  condition: 'OnClassCondition',
                  message: 'did match',
                },
              ],
            },
          },
        },
      },
    });
    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      springActuatorPath: 'runtime-actuator',
    });
    const owner = [...result.graph.iterNodes()].find(
      (node) => node.label === 'Class' && node.properties.name === 'RuntimeConfig',
    );
    const methodId = [...result.graph.iterRelationshipsByType('HAS_METHOD')].find(
      (edge) =>
        edge.sourceId === owner?.id &&
        result.graph.getNode(edge.targetId)?.properties.name === 'billingService',
    )?.targetId;
    const conditionTargets = [...result.graph.iterRelationshipsByType('CONDITIONAL_ON')]
      .filter((edge) => edge.sourceId === methodId)
      .map((edge) => result.graph.getNode(edge.targetId));
    assert.ok(
      result.graph
        .getNode(methodId ?? '')
        ?.properties.description.includes('Spring Actuator conditions not-matched'),
    );
    assert.ok(conditionTargets.length > 0);
    assert.equal(
      conditionTargets.some((node) =>
        String(node?.properties.description ?? '').includes(
          'Spring Actuator conditions not-matched',
        ),
      ),
      false,
    );
  } finally {
    removeTemporaryProjects();
  }
}
