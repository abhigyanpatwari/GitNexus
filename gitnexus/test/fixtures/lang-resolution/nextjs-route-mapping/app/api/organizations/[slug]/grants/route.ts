import { NextResponse } from 'next/server';

export async function GET(request: Request, { params }: { params: { slug: string } }) {
  const grants = await fetchOrgGrants(params.slug);
  return NextResponse.json({ data: grants });
}
