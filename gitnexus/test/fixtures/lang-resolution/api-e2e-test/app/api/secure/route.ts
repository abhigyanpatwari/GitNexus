import { NextResponse } from 'next/server';
import { withAuth } from '../../../middleware/auth';
import { withRateLimit } from '../../../middleware/rate-limit';

export const GET = withAuth(withRateLimit(async (req: Request) => {
  return NextResponse.json({ items: [], count: 0 });
}));

export const POST = async (req: Request) => {
  const body = await req.json();
  return NextResponse.json({ id: '123', created: true });
};
