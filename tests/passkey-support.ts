import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { request } from "./support.js";
const origin = process.env.MILL_WEB_URL!;
export function virtualPasskey(userId: string) {
  const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keyPair.publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  const id = randomBytes(32);
  const rpHash = createHash("sha256").update(new URL(origin).hostname).digest();
  const clientData = (
    type: string,
    challenge: string,
    expectedOrigin = origin,
  ) =>
    Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: expectedOrigin,
        crossOrigin: false,
      }),
    );
  let counter = 0;
  return {
    id: id.toString("base64url"),
    registration(challenge: string, expectedOrigin = origin) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authenticatorData = Buffer.concat([
        rpHash,
        Buffer.from([0x45]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        id,
        cose,
      ]);
      const attestation = isoCBOR.encode(
        new Map<string, string | Map<string, string> | Uint8Array>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authenticatorData],
        ]),
      );
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: clientData(
            "webauthn.create",
            challenge,
            expectedOrigin,
          ).toString("base64url"),
          attestationObject: Buffer.from(attestation).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    authentication(challenge: string, expectedOrigin = origin, flags = 0x05) {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const authenticatorData = Buffer.concat([
        rpHash,
        Buffer.from([flags]),
        count,
      ]);
      const client = clientData("webauthn.get", challenge, expectedOrigin);
      const signature = sign(
        "sha256",
        Buffer.concat([
          authenticatorData,
          createHash("sha256").update(client).digest(),
        ]),
        keyPair.privateKey,
      );
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString("base64url"),
          authenticatorData: authenticatorData.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle: Buffer.from(userId).toString("base64url"),
        },
      };
    },
  };
}
export async function registerPasskey(adminCookie: string, userId: string) {
  const passkey = virtualPasskey(userId);
  const options = await (
    await request("/api/auth/passkeys/register/options", {
      cookie: adminCookie,
      body: {},
    })
  ).json();
  const registered = await request("/api/auth/passkeys/register/verify", {
    cookie: adminCookie,
    body: {
      challengeId: options.challengeId,
      name: "Test passkey",
      response: passkey.registration(options.options.challenge),
    },
  });
  const result = await registered.json();
  assert.equal(registered.status, 200, JSON.stringify(result));
  return { ...passkey, recoveryCodes: result.recoveryCodes as string[] };
}
