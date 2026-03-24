import { NextResponse } from 'next/server';
import { fetchGrants } from '../../../lib/grants';

export async function GET() {
  try {
    const grants = await fetchGrants();
    return NextResponse.json({ data: grants, pagination: { page: 1, total: grants.length } });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch grants', message: String(err) }, { status: 400 });
  }
}
