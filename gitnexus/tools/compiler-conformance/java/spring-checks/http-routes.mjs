import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import { springFixture, springProject } from '../spring-support.mjs';
import { compareSpringJava } from '../spring-web-java.mjs';

const requests = [
  ['GET', '/api/users/list', 'UserController.java', 'listUsers'],
  ['POST', '/api/users/create', 'UserController.java', 'createUser'],
  ['DELETE', '/api/users/delete', 'UserController.java', 'deleteUser'],
  ['PUT', '/api/users/update', 'UserController.java', 'updateUser'],
  ['GET', '/api/orders/list', 'OrderController.java', 'listOrders'],
  ['POST', '/api/orders/submit', 'OrderController.java', 'submitOrder'],
  ['GET', '/health', 'HealthController.java', 'health'],
  ['GET', '/ready', 'HealthController.java', 'ready'],
  ['GET', '/api/admin/dashboard', 'MultiController.java', 'dashboard'],
  ['PATCH', '/api/admin/settings', 'MultiController.java', 'updateSettings'],
  ['GET', '/api/public/info', 'MultiController.java', 'info'],
  ['*', '/api/legacy/all', 'LegacyController.java', 'allMethods'],
  ['POST', '/api/legacy/save', 'LegacyController.java', 'save'],
  ['GET', '/api/legacy/inspect', 'LegacyController.java', 'inspect'],
  ['HEAD', '/api/legacy/inspect', 'LegacyController.java', 'inspect'],
];

// Route records contain four strings in method, path, file, handler order.
function compareRoutes(left, right) {
  for (const [index, value] of left.entries()) {
    const difference = compareCodeUnits(value, right[index]);
    if (difference) return difference;
  }
  return 0;
}

async function verifyRoutes(root, expected) {
  const result = await runPipelineFromRepo(root, () => {});
  const oracle = compareSpringJava(root, result);
  const graph = result.graph;
  const routes = [...graph.iterNodes()].filter((node) => node.label === 'Route');
  assert.equal(routes.length, expected.length, 'Unexpected standalone route or duplicated prefix');
  const actual = [];
  for (const edge of graph.iterRelationshipsByType('HANDLES_ROUTE')) {
    const file = graph.getNode(edge.sourceId);
    const route = graph.getNode(edge.targetId);
    if (file.label !== 'File') continue;
    assert.equal(route.label, 'Route');
    const handler = graph.getNode(route.properties.handlerSymbolId);
    assert.ok(handler && ['Method', 'Function'].includes(handler.label));
    assert.equal(handler.properties.filePath, file.properties.filePath);
    actual.push([
      route.properties.method,
      route.properties.name,
      file.properties.name,
      handler.properties.name,
    ]);
  }
  assert.deepEqual(actual.toSorted(compareRoutes), expected.toSorted(compareRoutes));
  return oracle;
}

export async function verifyMappedRoutes() {
  await verifyRoutes(springFixture('spring-route-app'), requests);
}

export async function verifyInterfaceRoutes() {
  const oracle = await verifyRoutes(springProject('route-inheritance'), [
    ['GET', '/orders/list', 'OrderController.java', 'list'],
    ['POST', '/orders/create', 'OrderController.java', 'create'],
  ]);
  assert.equal(
    oracle.heritage.length,
    1,
    'javac must see the controller implementing its route contract',
  );
}
