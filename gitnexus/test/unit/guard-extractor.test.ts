import { describe, it, expect } from 'vitest';
import { extractGuardClauses, extractGuardedCalls, type GuardClause, type GuardedCall } from '../../src/core/ingestion/guard-extractor.js';

describe('extractGuardClauses', () => {
  it('extracts early-return guard clauses from a route handler', () => {
    const content = `
async function handlePOST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!org) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // business logic
  const result = await createGrant(data);
  return NextResponse.json(result);
}`;
    const guards = extractGuardClauses(content, 'typescript');
    expect(guards).toHaveLength(2);
    expect(guards[0]).toMatchObject({
      condition: '!session',
      returnStatus: 401,
      line: expect.any(Number),
    });
    expect(guards[1]).toMatchObject({
      condition: '!org',
      returnStatus: 404,
      line: expect.any(Number),
    });
  });

  it('returns empty array for functions without guards', () => {
    const content = `function add(a: number, b: number) { return a + b; }`;
    const guards = extractGuardClauses(content, 'typescript');
    expect(guards).toEqual([]);
  });

  it('detects throw-based guard clauses in TypeScript/JavaScript', () => {
    const content = `
function validateUser(user: User) {
  if (!user) {
    throw new UnauthorizedException("User not found");
  }
  if (!user.isActive) {
    throw new ForbiddenException("Account disabled");
  }
  return user;
}`;
    const guards = extractGuardClauses(content, 'typescript');
    expect(guards).toHaveLength(2);
    expect(guards[0]).toMatchObject({
      condition: '!user',
      throwType: 'UnauthorizedException',
      line: expect.any(Number),
    });
    expect(guards[1]).toMatchObject({
      condition: '!user.isActive',
      throwType: 'ForbiddenException',
      line: expect.any(Number),
    });
  });

  it('detects mixed return and throw guard clauses', () => {
    const content = `
function handleRequest(req: Request) {
  if (!req.auth) {
    throw new UnauthorizedException();
  }
  if (!req.body) {
    return new Response(null, { status: 400 });
  }
  return processRequest(req);
}`;
    const guards = extractGuardClauses(content, 'typescript');
    expect(guards).toHaveLength(2);
    expect(guards[0]).toMatchObject({
      condition: '!req.auth',
      throwType: 'UnauthorizedException',
    });
    expect(guards[1]).toMatchObject({
      condition: '!req.body',
      returnStatus: 400,
    });
    // First guard should NOT have returnStatus, second should NOT have throwType
    expect(guards[0].returnStatus).toBeUndefined();
    expect(guards[1].throwType).toBeUndefined();
  });

  it('detects Python raise-based guard clauses', () => {
    const content = `
def handle(request):
    if not request.user.is_authenticated:
        raise PermissionDenied()
    if not request.data:
        raise ValidationError("No data")
    return process(request.data)
`;
    const guards = extractGuardClauses(content, 'python');
    expect(guards).toHaveLength(2);
    expect(guards[0]).toMatchObject({
      condition: 'not request.user.is_authenticated',
      throwType: 'PermissionDenied',
      line: expect.any(Number),
    });
    expect(guards[1]).toMatchObject({
      condition: 'not request.data',
      throwType: 'ValidationError',
      line: expect.any(Number),
    });
  });

  it('extracts throwType for Java-style throw new', () => {
    const content = `
function checkPermissions(user) {
  if (user === null) {
    throw new NullPointerException("user is null");
  }
  if (!user.hasRole("admin")) {
    throw new AccessDeniedException("admin required");
  }
}`;
    const guards = extractGuardClauses(content, 'javascript');
    expect(guards).toHaveLength(2);
    expect(guards[0].throwType).toBe('NullPointerException');
    expect(guards[1].throwType).toBe('AccessDeniedException');
  });
});

describe('extractGuardedCalls', () => {
  it('extracts the condition wrapping a function call', () => {
    const content = `
function processGrant(grant: Grant) {
  if (grant.status === 'submitted') {
    approveGrant(grant.id);
  }
  if (user.role === 'admin') {
    deleteGrant(grant.id);
  }
  alwaysCalled();
}`;
    const guarded = extractGuardedCalls(content, 'typescript');
    expect(guarded).toContainEqual(
      expect.objectContaining({
        calledName: 'approveGrant',
        guard: "grant.status === 'submitted'",
      })
    );
    expect(guarded).toContainEqual(
      expect.objectContaining({
        calledName: 'deleteGrant',
        guard: "user.role === 'admin'",
      })
    );
    // alwaysCalled has no guard
    expect(guarded.find(g => g.calledName === 'alwaysCalled')).toBeUndefined();
  });
});
