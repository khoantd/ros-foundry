import { describe, it, expect, afterEach } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { config } from "../apps/api/src/config.js";

type App = Awaited<ReturnType<typeof createApp>>;

async function hostedApp() {
  const store = new MemoryStore();
  const app = await createApp(store, { authMode: "hosted", licenseSeats: 2 });
  await app.ready();
  return { store, app };
}

function cookieHeader(res: { cookies: Array<{ name: string; value: string }> }) {
  const c = res.cookies.find((x) => x.name === "foundry_session");
  expect(c).toBeTruthy();
  return { cookie: `foundry_session=${c!.value}` };
}

describe("hosted auth", () => {
  const apps: App[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    config.authMode = "local";
    config.licenseSeats = 0;
  });

  it("rejects unauthenticated access and exposes auth status", async () => {
    const { app } = await hostedApp();
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(
      401,
    );
    const status = await app.inject({
      method: "GET",
      url: "/api/v1/auth/status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      mode: "hosted",
      bootstrapped: false,
      authenticated: false,
    });
  });

  it("bootstraps the first owner, logs in with a session cookie, and logs out", async () => {
    const { app, store } = await hostedApp();
    apps.push(app);
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: {
        email: "owner@example.com",
        password: "correct-horse",
        name: "Owner",
      },
    });
    expect(bootstrap.statusCode).toBe(200);
    const session = cookieHeader(bootstrap);
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: session });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({
      name: "Owner",
      email: "owner@example.com",
    });
    expect(me.json().workspaces).toHaveLength(1);
    expect(me.json().workspaces[0].role).toBe("owner");

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/bootstrap",
          payload: {
            email: "other@example.com",
            password: "correct-horse",
            name: "Other",
          },
        })
      ).statusCode,
    ).toBe(409);

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: session,
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/me", headers: session }))
        .statusCode,
    ).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "owner@example.com", password: "correct-horse" },
    });
    expect(login.statusCode).toBe(200);
    const again = cookieHeader(login);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/me", headers: again }))
        .statusCode,
    ).toBe(200);
    expect((await store.list("global", "user")).every((u) => !u.data.passwordHash || u.data.passwordHash.length > 20)).toBe(true);
  });

  it("invites a teammate within seat limits and accepts the invitation", async () => {
    const { app } = await hostedApp();
    apps.push(app);
    const owner = cookieHeader(
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/bootstrap",
        payload: {
          email: "owner@example.com",
          password: "correct-horse",
          name: "Owner",
        },
      }),
    );
    const me = (
      await app.inject({ method: "GET", url: "/api/v1/me", headers: owner })
    ).json();
    const scope = me.workspaces[0].id;

    const invite = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${scope}/invitations`,
      headers: owner,
      payload: { email: "editor@example.com", role: "editor" },
    });
    expect(invite.statusCode).toBe(200);
    const token = invite.json().token;
    expect(token).toBeTruthy();

    const members = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${scope}/members`,
      headers: owner,
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().items).toHaveLength(1);
    expect(members.json().invitations).toHaveLength(1);

    const accept = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      payload: {
        token,
        password: "editor-secret",
        name: "Editor",
      },
    });
    expect(accept.statusCode).toBe(200);
    const editor = cookieHeader(accept);
    const editorMe = (
      await app.inject({ method: "GET", url: "/api/v1/me", headers: editor })
    ).json();
    expect(editorMe.workspaces[0]).toMatchObject({ id: scope, role: "editor" });

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/workspaces/${scope}/invitations`,
          headers: owner,
          payload: { email: "viewer@example.com", role: "viewer" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("allows bootstrap after local mode left a passwordless local-user owner", async () => {
    const store = new MemoryStore();
    const workspaceId = "ws-from-local";
    await transaction(store, "global", async (tx) => {
      tx.put(resource("global", "user", "Local user", {}, "local-user"));
      tx.put(
        resource(
          "global",
          "installation",
          "ROS Foundry",
          { ownerId: "local-user" },
          "installation",
        ),
      );
      tx.put(resource("global", "workspaceRef", "Existing", {}, workspaceId));
      tx.put(
        resource(
          "global",
          "member",
          "Local user",
          { userId: "local-user", role: "owner", workspaceId },
          `local-user:${workspaceId}`,
        ),
      );
    });
    await transaction(store, workspaceId, async (tx) => {
      tx.put(
        resource(
          workspaceId,
          "workspace",
          "Existing",
          { activeGeneration: null, previousGeneration: null },
          "workspace",
        ),
      );
    });
    const app = await createApp(store, { authMode: "hosted", licenseSeats: 2 });
    apps.push(app);
    await app.ready();

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/auth/status",
    });
    expect(status.json()).toMatchObject({
      mode: "hosted",
      bootstrapped: false,
      authenticated: false,
    });

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: {
        email: "owner@example.com",
        password: "correct-horse",
        name: "Owner",
      },
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().workspace).toMatchObject({
      id: workspaceId,
      name: "Existing",
    });

    const session = cookieHeader(bootstrap);
    const me = (
      await app.inject({ method: "GET", url: "/api/v1/me", headers: session })
    ).json();
    expect(me.user).toMatchObject({
      name: "Owner",
      email: "owner@example.com",
    });
    expect(me.workspaces).toEqual([
      expect.objectContaining({ id: workspaceId, role: "owner" }),
    ]);
    expect(await store.get("global", `local-user:${workspaceId}`)).toBeUndefined();
  });

  it("rejects wrong passwords and keeps local mode without auth routes", async () => {
    const { app } = await hostedApp();
    apps.push(app);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      payload: {
        email: "owner@example.com",
        password: "correct-horse",
        name: "Owner",
      },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: "owner@example.com", password: "wrong-password" },
        })
      ).statusCode,
    ).toBe(401);

    const localStore = new MemoryStore();
    const local = await createApp(localStore, { authMode: "local" });
    apps.push(local);
    await local.ready();
    expect(
      (await local.inject({ method: "POST", url: "/api/v1/auth/login", payload: {} }))
        .statusCode,
    ).toBe(404);
    expect((await local.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(
      200,
    );
  });
});
