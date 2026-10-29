/**
 * Authentication HTTP routes (passwords and WebAuthn passkeys), spread into the
 * server's route table by serve.ts. Data-access lives in ../core/auth.ts; this
 * file is just the endpoints.
 *
 * RP ID and origin come from config (behind a reverse proxy the request's own
 * host/scheme are the local hop, not what the browser saw).
 */
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  CHALLENGE_COOKIE,
  challengeCookie,
  clearChallengeCookie,
  clearSessionCookie,
  countUsers,
  createSession,
  deleteSession,
  getCredentialById,
  getUser,
  hasPassword,
  insertCredential,
  isAcceptablePassword,
  listCredentialsForUser,
  PASSWORD_RULE,
  parseCookies,
  putChallenge,
  requireAuth,
  SESSION_COOKIE,
  sessionCookie,
  setPassword,
  takeChallenge,
  updateCredentialCounter,
  userWithPassword,
  verifyPassword,
} from "../core/auth.ts";
import { authConfig } from "../core/auth-config.ts";
import type { Library } from "../core/db.ts";

/** The answer every passkey ceremony gives while ZAYLA_URL is unset. */
const noPasskeys = () =>
  Response.json(
    { error: "passkeys need ZAYLA_URL, the address Zayla is opened at" },
    { status: 409 },
  );

/** The authentication ceremony routes, over this Library. */
export function authRoutes(lib: Library) {
  return {
    // Session probe the frontend calls on load: are we signed in, and does the
    // Library still need Setup because nobody exists yet?
    "/api/auth/me": {
      GET: (req: Bun.BunRequest) => {
        const user = requireAuth(lib, req);
        return Response.json({
          authenticated: !!user,
          user: user
            ? {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                hasPassword: hasPassword(lib, user.id),
              }
            : null,
          needsSetup: countUsers(lib) === 0,
          passkeysOffered: authConfig() !== null,
        });
      },
    },

    // Begin adding a passkey to the session user. The Library's first user
    // comes from Setup, with a password; a passkey is an upgrade on HTTPS, added
    // once signed in.
    "/api/auth/register/options": {
      POST: async (req: Bun.BunRequest) => {
        const user = requireAuth(lib, req);
        if (!user)
          return Response.json({ error: "unauthorized" }, { status: 401 });
        const cfg = authConfig();
        if (!cfg) return noPasskeys();
        const userID = new Uint8Array(new ArrayBuffer(16));
        crypto.getRandomValues(userID);
        const options = await generateRegistrationOptions({
          rpName: cfg.rpName,
          rpID: cfg.rpID,
          userName: user.username,
          excludeCredentials: listCredentialsForUser(lib, user.id).map((c) => ({
            id: c.id,
            transports: c.transports ?? undefined,
          })),
          userID,
          authenticatorSelection: {
            residentKey: "required",
            userVerification: "preferred",
          },
        });
        const chalId = putChallenge(lib, options.challenge);
        return Response.json(options, {
          headers: { "Set-Cookie": challengeCookie(req, chalId) },
        });
      },
    },

    "/api/auth/register/verify": {
      POST: async (req: Bun.BunRequest) => {
        const user = requireAuth(lib, req);
        if (!user)
          return Response.json({ error: "unauthorized" }, { status: 401 });
        const chalId = parseCookies(req)[CHALLENGE_COOKIE];
        const expectedChallenge = chalId ? takeChallenge(lib, chalId) : null;
        if (!expectedChallenge)
          return Response.json({ error: "challenge expired" }, { status: 400 });
        const cfg = authConfig();
        if (!cfg) return noPasskeys();
        let verification: Awaited<
          ReturnType<typeof verifyRegistrationResponse>
        >;
        try {
          verification = await verifyRegistrationResponse({
            response: (await req.json()) as RegistrationResponseJSON,
            expectedChallenge,
            expectedOrigin: cfg.rpOrigin,
            expectedRPID: cfg.rpID,
          });
        } catch (err) {
          return Response.json(
            { error: (err as Error).message },
            { status: 400 },
          );
        }
        if (!verification.verified || !verification.registrationInfo)
          return Response.json(
            { error: "verification failed" },
            { status: 400 },
          );
        const { credential, credentialDeviceType, credentialBackedUp } =
          verification.registrationInfo;
        insertCredential(lib, {
          id: credential.id,
          userId: user.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
        });
        return Response.json(
          { passkeys: listCredentialsForUser(lib, user.id).length },
          { headers: { "Set-Cookie": clearChallengeCookie(req) } },
        );
      },
    },

    // Begin login. No allowCredentials → the browser offers any discoverable
    // (resident) passkey for this RP — usernameless, ideal for a lone owner.
    "/api/auth/login/options": {
      POST: async (req: Bun.BunRequest) => {
        const cfg = authConfig();
        if (!cfg) return noPasskeys();
        const options = await generateAuthenticationOptions({
          rpID: cfg.rpID,
          userVerification: "preferred",
        });
        const chalId = putChallenge(lib, options.challenge);
        return Response.json(options, {
          headers: { "Set-Cookie": challengeCookie(req, chalId) },
        });
      },
    },

    "/api/auth/login/verify": {
      POST: async (req: Bun.BunRequest) => {
        const chalId = parseCookies(req)[CHALLENGE_COOKIE];
        const expectedChallenge = chalId ? takeChallenge(lib, chalId) : null;
        if (!expectedChallenge)
          return Response.json({ error: "challenge expired" }, { status: 400 });
        const body = (await req.json()) as AuthenticationResponseJSON;
        const cred = getCredentialById(lib, body.id);
        if (!cred)
          return Response.json(
            { error: "unknown credential" },
            { status: 400 },
          );
        const cfg = authConfig();
        if (!cfg) return noPasskeys();
        let verification: Awaited<
          ReturnType<typeof verifyAuthenticationResponse>
        >;
        try {
          verification = await verifyAuthenticationResponse({
            response: body,
            expectedChallenge,
            expectedOrigin: cfg.rpOrigin,
            expectedRPID: cfg.rpID,
            credential: {
              id: cred.id,
              publicKey: cred.publicKey,
              counter: cred.counter,
              transports: cred.transports ?? undefined,
            },
          });
        } catch (err) {
          return Response.json(
            { error: (err as Error).message },
            { status: 400 },
          );
        }
        if (!verification.verified)
          return Response.json(
            { error: "verification failed" },
            { status: 400 },
          );
        updateCredentialCounter(
          lib,
          cred.id,
          verification.authenticationInfo.newCounter,
        );
        const token = createSession(lib, cred.userId);
        const user = getUser(lib, cred.userId);
        const headers = new Headers();
        headers.append("Set-Cookie", sessionCookie(req, token));
        headers.append("Set-Cookie", clearChallengeCookie(req));
        return Response.json(
          {
            authenticated: true,
            user: user ? { id: user.id, username: user.username } : null,
          },
          { headers },
        );
      },
    },

    // Sign in with a password alone: no username while the Library has one
    // user. A wrong one is refused the same way whether or not anyone has a
    // password, so the answer says nothing about the account.
    "/api/auth/password/login": {
      POST: async (req: Bun.BunRequest) => {
        const body = (await req.json().catch(() => null)) as {
          password?: unknown;
        } | null;
        const password = body?.password;
        const user =
          typeof password === "string"
            ? await userWithPassword(lib, password)
            : null;
        if (!user)
          return Response.json({ error: "wrong password" }, { status: 401 });
        const token = createSession(lib, user.id);
        return Response.json(
          {
            authenticated: true,
            user: { id: user.id, username: user.username },
          },
          { headers: { "Set-Cookie": sessionCookie(req, token) } },
        );
      },
    },

    // Add a password, or replace the one the session user has. Never required:
    // a passkey alone stays a way in.
    "/api/auth/password": {
      PUT: async (req: Bun.BunRequest) => {
        const body = (await req.json().catch(() => null)) as {
          password?: unknown;
          currentPassword?: unknown;
        } | null;
        const user = requireAuth(lib, req);
        if (!user)
          return Response.json({ error: "unauthorized" }, { status: 401 });
        const password = body?.password;
        if (!isAcceptablePassword(password))
          return Response.json({ error: PASSWORD_RULE }, { status: 400 });
        // A session alone doesn't change a password someone already has: it
        // could be a browser left signed in.
        const current = body?.currentPassword;
        if (
          hasPassword(lib, user.id) &&
          !(
            typeof current === "string" &&
            (await verifyPassword(lib, user.id, current))
          )
        )
          return Response.json(
            { error: "the current password is wrong" },
            { status: 403 },
          );
        await setPassword(lib, user.id, password);
        return Response.json({ hasPassword: true });
      },
    },

    "/api/auth/logout": {
      POST: (req: Bun.BunRequest) => {
        const token = parseCookies(req)[SESSION_COOKIE];
        if (token) deleteSession(lib, token);
        return Response.json(
          { authenticated: false },
          { headers: { "Set-Cookie": clearSessionCookie(req) } },
        );
      },
    },
  };
}
