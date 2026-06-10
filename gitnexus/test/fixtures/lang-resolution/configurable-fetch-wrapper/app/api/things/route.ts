import { NextResponse } from 'next/server';

export async function GET() {
  const things = [{ id: 1, name: 'Widget' }];
  return NextResponse.json(things);
}
