import { NextResponse } from 'next/server';

export async function GET() {
  const grants = await fetchGrants();
  return NextResponse.json({ data: grants, pagination: { page: 1 } });
}
