import { NextResponse } from 'next/server';

export async function GET() {
  const grants = [{ id: 1, name: 'Research Grant' }];
  return NextResponse.json(grants);
}
