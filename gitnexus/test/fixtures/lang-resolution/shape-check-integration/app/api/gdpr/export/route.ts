import { NextResponse } from 'next/server';

export async function POST() {
  const archive = await buildExport();
  return NextResponse.json({ url: archive.url });
}
