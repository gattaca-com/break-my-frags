import { registryStore } from '@/lib/registryStore';
import { NextResponse } from 'next/server';

export async function GET() {
  console.log("Serving registry data");
  const data = registryStore.getData();
  return NextResponse.json(data);
} 