import { describe, it, expect } from 'vitest';
import {
  extractStatusTypes,
  extractStatusTransitions,
  type DetectedStatusType,
  type DetectedTransition,
} from '../../src/core/ingestion/workflow-detector.js';

describe('extractStatusTypes', () => {
  it('extracts TypeScript union type status definitions', () => {
    const content = `
export type GrantStatus = 'DRAFT' | 'ACTIVE' | 'AT_RISK' | 'ON_HOLD' | 'COMPLETED' | 'CLOSED';
export type ProjectStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
`;
    const types = extractStatusTypes(content, 'typescript', 'status-rules.ts');
    expect(types).toHaveLength(2);
    expect(types[0]).toMatchObject({
      name: 'GrantStatus',
      values: ['DRAFT', 'ACTIVE', 'AT_RISK', 'ON_HOLD', 'COMPLETED', 'CLOSED'],
      filePath: 'status-rules.ts',
    });
    expect(types[1]).toMatchObject({
      name: 'ProjectStatus',
      values: ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    });
  });

  it('extracts lowercase approval status types', () => {
    const content = `
export type ApprovalInstanceStatus = 'pending' | 'approved' | 'rejected' | 'escalated' | 'cancelled';
`;
    const types = extractStatusTypes(content, 'typescript', 'workflow.ts');
    expect(types).toHaveLength(1);
    expect(types[0].values).toContain('pending');
    expect(types[0].values).toContain('approved');
  });

  it('extracts enum-based status definitions', () => {
    const content = `
enum OrderStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
}
`;
    const types = extractStatusTypes(content, 'typescript', 'order.ts');
    expect(types).toHaveLength(1);
    expect(types[0].name).toBe('OrderStatus');
    expect(types[0].values).toEqual(['pending', 'processing', 'shipped', 'delivered']);
  });

  it('ignores non-status union types', () => {
    const content = `
export type Color = 'red' | 'blue' | 'green';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
`;
    const types = extractStatusTypes(content, 'typescript', 'utils.ts');
    // HttpMethod might match due to keyword heuristics, but Color should not
    expect(types.find(t => t.name === 'Color')).toBeUndefined();
  });

  it('extracts Python Enum status types', () => {
    const content = `
class OrderStatus(Enum):
    PENDING = 'pending'
    SHIPPED = 'shipped'
    DELIVERED = 'delivered'
`;
    const types = extractStatusTypes(content, 'python', 'models.py');
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({
      name: 'OrderStatus',
      values: ['pending', 'shipped', 'delivered'],
      kind: 'enum',
      filePath: 'models.py',
    });
  });

  it('extracts Java enum status types (no string values)', () => {
    const content = `
public enum OrderStatus { PENDING, ACTIVE, COMPLETED, CANCELLED }
`;
    const types = extractStatusTypes(content, 'java', 'Order.java');
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({
      name: 'OrderStatus',
      values: ['PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED'],
      kind: 'enum',
      filePath: 'Order.java',
    });
  });
});

describe('extractStatusTransitions', () => {
  it('detects Prisma status update patterns', () => {
    const content = `
async function approveGrant(grantId: string) {
  await prisma.grant.update({
    where: { id: grantId },
    data: { status: 'ACTIVE' },
  });
}
`;
    const transitions = extractStatusTransitions(content, 'typescript', 'engine.ts');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      toStatus: 'ACTIVE',
      entityType: 'grant',
      functionName: 'approveGrant',
      filePath: 'engine.ts',
    });
  });

  it('detects conditional status transitions with fromStatus', () => {
    const content = `
async function submitGrant(grant: Grant) {
  if (grant.status === 'DRAFT') {
    await prisma.grant.update({
      where: { id: grant.id },
      data: { status: 'ACTIVE' },
    });
  }
}
`;
    const transitions = extractStatusTransitions(content, 'typescript', 'route.ts');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      fromStatus: 'DRAFT',
      toStatus: 'ACTIVE',
    });
  });

  it('detects transactional status updates', () => {
    const content = `
await prisma.$transaction(async (tx) => {
  await tx.approvalStepInstance.update({
    where: { id: stepInstance.id },
    data: { status: 'approved' },
  });
});
`;
    const transitions = extractStatusTransitions(content, 'typescript', 'engine.ts');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      toStatus: 'approved',
      entityType: 'approvalStepInstance',
      isTransactional: true,
    });
  });

  it('detects direct assignment transitions', () => {
    const content = `
function shipOrder(order) {
  order.status = 'shipped';
}
`;
    const transitions = extractStatusTransitions(content, 'javascript', 'order.js');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      toStatus: 'shipped',
      entityType: 'order',
      functionName: 'shipOrder',
    });
  });

  it('detects setter pattern transitions', () => {
    const content = `
function approve(entity) {
  entity.setStatus('approved');
}
`;
    const transitions = extractStatusTransitions(content, 'typescript', 'service.ts');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      toStatus: 'approved',
      entityType: 'entity',
    });
  });

  it('detects Python self.status assignment', () => {
    const content = `
def activate(self):
    self.status = 'active'
`;
    const transitions = extractStatusTransitions(content, 'python', 'model.py');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      toStatus: 'active',
      entityType: 'self',
      filePath: 'model.py',
    });
  });

  it('detects generic .update() with status field', () => {
    const content = `
function completeTask(task) {
  task.update({ status: 'completed', finishedAt: new Date() });
}
`;
    const transitions = extractStatusTransitions(content, 'javascript', 'task.js');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      toStatus: 'completed',
      entityType: 'task',
    });
  });

  it('detects set_status snake_case setter', () => {
    const content = `
def process(order):
    order.set_status('processing')
`;
    const transitions = extractStatusTransitions(content, 'python', 'service.py');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      toStatus: 'processing',
      entityType: 'order',
    });
  });
});
