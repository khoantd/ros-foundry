import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Resource, Role } from "../../../packages/shared/src/index.js";
import { RoleSchema } from "../../../packages/shared/src/index.js";
import type { AuthMode } from "./config.js";
import { config } from "./config.js";
import { assertCanAddSeats, getLicense } from "./license.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { assert, digest, token } from "./security.js";
import { resource, transaction, type Store } from "./store.js";

export const SESSION_COOKIE = "foundry_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;

const Credentials = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(100).optional(),
});

export type AuthAccess = (
  req: any,
  min?: Role,
) => Promise<{ user: Resource; session: Resource; scope: string; role: Role }>;

export type AuthUser = (
  req: any,
) => Promise<{ user: Resource; session: Resource }>;

export type NewWorkspace = (
  owner: Resource,
  name: string,
) => Promise<{ id: string; name: string }>;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function cookieOpts() {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.origin.startsWith("https:"),
    maxAge: SESSION_MS / 1000,
  };
}

async function setSession(
  store: Store,
  reply: FastifyReply,
  user: Resource,
) {
  const raw = token();
  await transaction(store, "global", async (tx) => {
    tx.put(
      resource(
        "global",
        "session",
        "Browser session",
        {
          userId: user.id,
          expiresAt: Date.now() + SESSION_MS,
        },
        digest(raw),
      ),
    );
  });
  reply.setCookie(SESSION_COOKIE, raw, cookieOpts());
  return raw;
}

async function findUserByEmail(store: Store, email: string) {
  const want = normalizeEmail(email);
  for (const u of await store.list("global", "user"))
    if (normalizeEmail(String(u.data.email || "")) === want) return u;
}

/** Hosted bootstrap is complete only when the owner can sign in with a password. */
async function hostedOwner(store: Store) {
  const installation = await store.get("global", "installation");
  const ownerId = installation?.data.ownerId;
  if (!ownerId) return null;
  const u = await store.get("global", ownerId);
  if (u?.kind !== "user" || !u.data.email || !u.data.passwordHash) return null;
  return u;
}

async function seatCount(store: Store, workspaceId: string) {
  const members = (await store.list("global", "member")).filter(
    (m) => m.data.workspaceId === workspaceId,
  );
  const invites = (await store.list("global", "invitation")).filter(
    (i) =>
      i.data.workspaceId === workspaceId &&
      !i.data.acceptedAt &&
      (!i.data.expiresAt || i.data.expiresAt > Date.now()),
  );
  return members.length + invites.length;
}

function seatLimit(fallback: number) {
  return getLicense().seats || fallback;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  store: Store,
  deps: {
    authMode: AuthMode;
    licenseSeats: number;
    user: AuthUser;
    access: AuthAccess;
    newWorkspace: NewWorkspace;
  },
) {
  const { authMode, licenseSeats, user, access, newWorkspace } = deps;
  if (authMode !== "hosted") return;

  app.get("/api/v1/auth/status", async (req) => {
    let authenticated = false;
    try {
      await user(req);
      authenticated = true;
    } catch {
      authenticated = false;
    }
    return {
      mode: "hosted" as const,
      bootstrapped: Boolean(await hostedOwner(store)),
      authenticated,
    };
  });

  app.post("/api/v1/auth/bootstrap", async (req, reply) => {
    const body = Credentials.extend({
      name: z.string().trim().min(1).max(100),
    }).parse(req.body);
    assert(
      !(await hostedOwner(store)),
      "This installation already has an owner. Sign in instead.",
      409,
    );
    const email = normalizeEmail(body.email);
    assert(!(await findUserByEmail(store, email)), "Email is already registered", 409);
    const passwordHash = await hashPassword(body.password);
    const installation = await store.get("global", "installation");
    const previousOwnerId =
      installation?.data.ownerId && String(installation.data.ownerId);
    const owner = await transaction(store, "global", async (tx) => {
      const u = tx.put(
        resource(
          "global",
          "user",
          body.name,
          { email, passwordHash },
          randomUUID(),
        ),
      );
      tx.put(
        resource(
          "global",
          "installation",
          "ROS Foundry",
          { ownerId: u.id },
          "installation",
        ),
      );
      // Claim workspaces left by local mode's passwordless "local-user".
      if (previousOwnerId && previousOwnerId !== u.id) {
        for (const ref of await tx.list("workspaceRef")) {
          const prior = await tx.get(`${previousOwnerId}:${ref.id}`);
          if (prior?.kind !== "member") continue;
          tx.put(
            resource(
              "global",
              "member",
              body.name,
              { userId: u.id, role: "owner", workspaceId: ref.id },
              `${u.id}:${ref.id}`,
            ),
          );
          tx.delete(prior.id);
        }
      }
      return u;
    });
    const refs = await store.list("global", "workspaceRef");
    const ws = refs.length
      ? { id: refs[0].id, name: refs[0].name }
      : await newWorkspace(owner, "My workspace");
    await setSession(store, reply, owner);
    return {
      user: { id: owner.id, name: owner.name, email },
      workspace: ws,
    };
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    const body = Credentials.omit({ name: true }).parse(req.body);
    const u = await findUserByEmail(store, body.email);
    assert(u?.data.passwordHash, "Invalid email or password", 401);
    assert(
      await verifyPassword(body.password, u.data.passwordHash),
      "Invalid email or password",
      401,
    );
    await setSession(store, reply, u);
    return { user: { id: u.id, name: u.name, email: u.data.email } };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw)
      await transaction(store, "global", async (tx) => {
        const s = await tx.get(digest(raw));
        if (s?.kind === "session") tx.delete(s.id);
      });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/v1/workspaces/:w/members", async (req) => {
    const a = await access(req);
    const members = (await store.list("global", "member"))
      .filter((m) => m.data.workspaceId === a.scope)
      .map(async (m) => {
        const u = await store.get("global", m.data.userId);
        return {
          id: m.id,
          userId: m.data.userId,
          name: u?.name || m.name,
          email: u?.data.email || null,
          role: m.data.role as Role,
        };
      });
    const invitations = (await store.list("global", "invitation"))
      .filter(
        (i) =>
          i.data.workspaceId === a.scope &&
          !i.data.acceptedAt &&
          (!i.data.expiresAt || i.data.expiresAt > Date.now()),
      )
      .map((i) => ({
        id: i.id,
        email: i.data.email,
        role: i.data.role as Role,
        expiresAt: i.data.expiresAt
          ? new Date(i.data.expiresAt).toISOString()
          : null,
      }));
    return {
      items: await Promise.all(members),
      invitations,
      seats: {
        used: await seatCount(store, a.scope),
        limit: seatLimit(licenseSeats) || null,
      },
    };
  });

  app.post("/api/v1/workspaces/:w/invitations", async (req) => {
    const a = await access(req, "owner");
    const body = z
      .object({
        email: z.string().trim().email().max(255),
        role: RoleSchema.exclude(["owner"]).default("editor"),
      })
      .parse(req.body);
    const email = normalizeEmail(body.email);
    await assertCanAddSeats(store, a.scope);
    const existing = await findUserByEmail(store, email);
    if (existing) {
      const m = await store.get("global", `${existing.id}:${a.scope}`);
      assert(!m || m.kind !== "member", "User is already a member", 409);
    }
    const raw = token();
    await transaction(store, "global", async (tx) => {
      tx.put(
        resource(
          "global",
          "invitation",
          email,
          {
            email,
            role: body.role,
            workspaceId: a.scope,
            invitedBy: a.user.id,
            expiresAt: Date.now() + INVITE_MS,
            acceptedAt: null,
          },
          digest(raw),
        ),
      );
    });
    return {
      token: raw,
      email,
      role: body.role,
      expiresInDays: 7,
    };
  });

  app.post("/api/v1/invitations/accept", async (req, reply) => {
    const body = z
      .object({
        token: z.string().min(10).max(200),
        password: z.string().min(8).max(128),
        name: z.string().trim().min(1).max(100).optional(),
      })
      .parse(req.body);
    const invite = await store.get("global", digest(body.token));
    assert(
      invite?.kind === "invitation" &&
        !invite.data.acceptedAt &&
        (!invite.data.expiresAt || invite.data.expiresAt > Date.now()),
      "Invitation is invalid or expired",
      404,
    );
    const email = normalizeEmail(invite.data.email);
    let u = await findUserByEmail(store, email);
    if (u) {
      assert(u.data.passwordHash, "Account cannot accept invitations", 400);
      assert(
        await verifyPassword(body.password, u.data.passwordHash),
        "Invalid email or password",
        401,
      );
    } else {
      assert(body.name, "Name is required for new accounts", 400);
      const passwordHash = await hashPassword(body.password);
      u = await transaction(store, "global", async (tx) =>
        tx.put(
          resource(
            "global",
            "user",
            body.name!,
            { email, passwordHash },
            randomUUID(),
          ),
        ),
      );
    }
    const memberId = `${u.id}:${invite.data.workspaceId}`;
    assert(
      !(await store.get("global", memberId)),
      "Already a member of this workspace",
      409,
    );
    // The pending invite already reserved a seat; only block if members alone
    // are at the limit (invite converts to a membership).
    const membersOnly = (await store.list("global", "member")).filter(
      (m) => m.data.workspaceId === invite.data.workspaceId,
    ).length;
    const seats = seatLimit(licenseSeats);
    if (seats > 0)
      assert(
        membersOnly < seats,
        "Seat limit reached for this workspace. Upgrade your plan or remove a member.",
        403,
        "QUOTA_EXCEEDED",
      );
    await transaction(store, "global", async (tx) => {
      tx.put(
        resource(
          "global",
          "member",
          u!.name,
          {
            userId: u!.id,
            role: invite.data.role,
            workspaceId: invite.data.workspaceId,
          },
          memberId,
        ),
      );
      tx.update(invite, { ...invite.data, acceptedAt: Date.now() });
    });
    await setSession(store, reply, u);
    return {
      user: { id: u.id, name: u.name, email },
      workspaceId: invite.data.workspaceId,
      role: invite.data.role,
    };
  });
}

/** Resolve a browser session cookie into a user, or null. */
export async function sessionFromCookie(
  store: Store,
  req: { cookies?: Record<string, string | undefined> },
): Promise<{ user: Resource; session: Resource } | null> {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const s = await store.get("global", digest(raw));
  if (
    s?.kind !== "session" ||
    (s.data.expiresAt && s.data.expiresAt <= Date.now())
  )
    return null;
  const u = await store.get("global", s.data.userId);
  if (!u) return null;
  return { user: u, session: s };
}
