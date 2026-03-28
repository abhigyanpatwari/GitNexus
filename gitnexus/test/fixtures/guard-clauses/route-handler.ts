// Next.js route handler with typical guard clause patterns
import { NextRequest, NextResponse } from 'next/server';

async function handlePOST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const org = await getOrg(slug);
  if (!org) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!hasPermission(session.role, 'grants.create')) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Business logic - only reached after all guards pass
  const result = await createGrant(data);

  if (result.requiresApproval) {
    initializeApprovalWorkflow(result.id);
  }

  return NextResponse.json(result);
}
