import { NextResponse } from 'next/server';

export async function GET() {
  const users = await getUsers();
  return NextResponse.json({ data: users, total: users.length });
}

export async function POST(req: Request) {
  const body = await req.json();
  if (!body.name) {
    return NextResponse.json({ error: 'Name required', details: 'missing field' }, { status: 400 });
  }
  return NextResponse.json({ data: body, success: true });
}
