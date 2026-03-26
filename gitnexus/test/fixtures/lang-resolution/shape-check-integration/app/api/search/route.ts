import { NextResponse } from 'next/server';

export async function GET() {
  const courses = await getCourses();
  const articles = await getArticles();
  return NextResponse.json({ 'courses': courses, 'articles': articles });
}
