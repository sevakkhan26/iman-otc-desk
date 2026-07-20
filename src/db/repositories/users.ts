import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import type { DeskRole } from "@/lib/auth";

export type PgUserRow = {
  id: string;
  username: string;
  usernameKey: string;
  passwordHash: string;
  role: DeskRole;
  isActive: boolean;
  credentialVersion: number;
  source: string;
  createdAt: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

export async function pgListUsers(): Promise<PgUserRow[]> {
  const db = getDb();
  const rows = await db.select().from(users);
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    usernameKey: r.usernameKey,
    passwordHash: r.passwordHash,
    role: r.role as DeskRole,
    isActive: r.isActive,
    credentialVersion: r.credentialVersion,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy
  }));
}

export async function pgFindUserByUsernameKey(usernameKey: string): Promise<PgUserRow | null> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.usernameKey, usernameKey)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    usernameKey: r.usernameKey,
    passwordHash: r.passwordHash,
    role: r.role as DeskRole,
    isActive: r.isActive,
    credentialVersion: r.credentialVersion,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy
  };
}

export async function pgUpsertUser(input: {
  id?: string;
  username: string;
  usernameKey: string;
  passwordHash: string;
  role: DeskRole;
  isActive?: boolean;
  credentialVersion?: number;
  source?: string;
  updatedBy?: string | null;
}): Promise<string> {
  const db = getDb();
  const existing = await pgFindUserByUsernameKey(input.usernameKey);
  if (existing) {
    await db
      .update(users)
      .set({
        passwordHash: input.passwordHash,
        role: input.role,
        isActive: input.isActive ?? existing.isActive,
        credentialVersion: input.credentialVersion ?? existing.credentialVersion,
        updatedAt: new Date().toISOString(),
        updatedBy: input.updatedBy ?? null
      })
      .where(eq(users.id, existing.id));
    return existing.id;
  }
  const id = input.id ?? randomUUID();
  await db.insert(users).values({
    id,
    username: input.username,
    usernameKey: input.usernameKey,
    passwordHash: input.passwordHash,
    role: input.role,
    isActive: input.isActive ?? true,
    credentialVersion: input.credentialVersion ?? 0,
    source: input.source ?? "managed",
    createdAt: new Date().toISOString(),
    updatedBy: input.updatedBy ?? null
  });
  return id;
}

export async function pgBumpCredentialVersion(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!rows[0]) return 0;
  const next = rows[0].credentialVersion + 1;
  await db
    .update(users)
    .set({ credentialVersion: next, updatedAt: new Date().toISOString() })
    .where(eq(users.id, userId));
  return next;
}

export async function pgSetUserActive(userId: string, isActive: boolean): Promise<void> {
  const db = getDb();
  await db
    .update(users)
    .set({ isActive, updatedAt: new Date().toISOString() })
    .where(eq(users.id, userId));
}

export async function pgDeleteUser(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(users).where(eq(users.id, userId));
}
