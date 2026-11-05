import { NextResponse } from "next/server";
import { z } from "zod";
import { signIn } from "@/lib/auth";

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(72),
}).strict();

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 400 });
  }

  const user = await signIn(parsed.data.email, parsed.data.password);
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  return NextResponse.json({ user });
}
