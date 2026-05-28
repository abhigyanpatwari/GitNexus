import { NextResponse } from 'next/server';

export async function GET() {
  const users = [{ id: 1, username: 'admin' }];
  return NextResponse.json(users);
}
