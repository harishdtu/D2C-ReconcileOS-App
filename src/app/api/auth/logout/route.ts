import { NextResponse } from "next/server";
import { signOut } from "@/lib/auth";

export async function POST() {
  await signOut();
  return new NextResponse(null, { status: 204 });
}
