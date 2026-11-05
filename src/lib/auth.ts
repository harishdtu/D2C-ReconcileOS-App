import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { hasPermission, type Permission } from "./authorization";
import { prisma } from "./db";

const SESSION_COOKIE = "reconcileos_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 5;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  "not-a-valid-reconcileos-password",
  12,
);

export type AuthenticatedUser = {
  id: string;
  email: string;
  role: UserRole;
};

export class AuthenticationError extends Error {
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  constructor(message = "This action is not permitted.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toAuthenticatedUser(user: {
  id: string;
  email: string;
  role: UserRole;
}): AuthenticatedUser {
  return { id: user.id, email: user.email, role: user.role };
}

async function loginIsBlocked(keyHash: string, now: Date): Promise<boolean> {
  const record = await prisma.loginRateLimit.findUnique({
    where: { keyHash },
    select: { blockedUntil: true },
  });
  return record?.blockedUntil !== null && record?.blockedUntil !== undefined
    ? record.blockedUntil > now
    : false;
}

async function recordFailedLogin(keyHash: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - LOGIN_WINDOW_MS);

  await prisma.$queryRaw`
    INSERT INTO "login_rate_limits" ("key_hash", "attempts", "window_started", "updated_at")
    VALUES (${keyHash}, 1, ${now}, ${now})
    ON CONFLICT ("key_hash") DO UPDATE SET
      "attempts" = CASE
        WHEN "login_rate_limits"."window_started" <= ${cutoff} THEN 1
        ELSE "login_rate_limits"."attempts" + 1
      END,
      "window_started" = CASE
        WHEN "login_rate_limits"."window_started" <= ${cutoff} THEN ${now}
        ELSE "login_rate_limits"."window_started"
      END,
      "blocked_until" = CASE
        WHEN "login_rate_limits"."window_started" <= ${cutoff} THEN NULL
        WHEN "login_rate_limits"."attempts" + 1 >= ${LOGIN_LIMIT}
          THEN ${now} + INTERVAL '15 minutes'
        ELSE "login_rate_limits"."blocked_until"
      END,
      "updated_at" = ${now}
  `;
}

export async function authenticateCredentials(
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const rateLimitKey = hash(normalizedEmail);
  const now = new Date();

  if (await loginIsBlocked(rateLimitKey, now)) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true, role: true, passwordHash: true, isActive: true },
  });
  const passwordMatches = await bcrypt.compare(
    password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  if (!user || !user.isActive || !passwordMatches) {
    await recordFailedLogin(rateLimitKey, now);
    return null;
  }

  await prisma.loginRateLimit.deleteMany({ where: { keyHash: rateLimitKey } });
  return toAuthenticatedUser(user);
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: { userId, tokenHash: hash(token), expiresAt },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function signIn(
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const user = await authenticateCredentials(email, password);
  if (user) {
    await createSession(user.id);
  }
  return user;
}

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }

  const tokenHash = hash(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!session) {
    return null;
  }

  if (session.expiresAt <= new Date() || !session.user.isActive) {
    await prisma.session.deleteMany({ where: { id: session.id } });
    return null;
  }

  return toAuthenticatedUser(session.user);
}

export async function signOut(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hash(token) } });
  }
  cookieStore.delete(SESSION_COOKIE);
}

export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser();
  if (!user) {
    throw new AuthenticationError();
  }
  return user;
}

export async function requirePermission(
  permission: Permission,
): Promise<AuthenticatedUser> {
  const user = await requireAuthenticatedUser();
  if (!hasPermission(user.role, permission)) {
    throw new AuthorizationError();
  }
  return user;
}
