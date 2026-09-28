import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { z } from "zod";
import { sql } from "../../../../packages/database/src/index.js";
import {
  clientMetadataSchema,
  digest,
  equalHash,
  OAuthError,
  secret,
} from "./protocol.js";

export type OAuthClient = {
  id: string;
  name: string;
  redirectUris: string[];
  authMethod: "none" | "client_secret_basic" | "client_secret_post";
  secretHash: string | null;
  trust: "metadata-document" | "unverified";
};
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return (
      a !== undefined &&
      a > 0 &&
      a < 224 &&
      a !== 10 &&
      a !== 127 &&
      !(a === 100 && b! >= 64 && b! <= 127) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b! >= 16 && b! <= 31) &&
      !(
        a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 88 && c === 99))
      ) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
      !(a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const [first, second] = address
      .split(":")
      .map((value) => Number.parseInt(value || "0", 16));
    // Only global unicast is accepted; block documentation, transition and special-use space.
    return (
      first! >= 0x2000 &&
      first! < 0x3fff &&
      first !== 0x2002 &&
      !(first === 0x2001 && (second! < 0x200 || second === 0xdb8))
    );
  }
  return false;
}
export function metadataDocumentUrl(id: string) {
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    throw new OAuthError("invalid_client", "Invalid client metadata URL");
  }
  if (
    id.length > 2048 ||
    url.protocol !== "https:" ||
    url.pathname === "/" ||
    id.includes("#") ||
    url.username ||
    url.password ||
    isIP(url.hostname.replace(/^\[|\]$/g, ""))
  )
    throw new OAuthError(
      "invalid_client",
      "Client metadata must use a public HTTPS document URL",
    );
  return url;
}
export async function fetchClientDocument(id: string): Promise<unknown> {
  const url = metadataDocumentUrl(id);
  const deadline = Date.now() + 5000;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_resolve, reject) => {
      dnsTimer = setTimeout(
        () =>
          reject(
            new OAuthError(
              "invalid_client",
              "Client metadata lookup timed out",
            ),
          ),
        5000,
      );
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    throw new OAuthError(
      "invalid_client",
      "Client metadata must be hosted on a public network",
    );
  return new Promise((resolve, reject) => {
    const pinned = addresses[0]!;
    const req = request(
      url,
      {
        headers: { accept: "application/json" },
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, addresses)
            : callback(null, pinned.address, pinned.family),
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          !res.headers["content-type"]?.includes("application/json")
        ) {
          res.destroy();
          reject(
            new OAuthError(
              "invalid_client",
              "Client metadata could not be read",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 32768) {
            res.destroy();
            reject(
              new OAuthError("invalid_client", "Client metadata is too large"),
            );
          } else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            );
          } catch {
            reject(new OAuthError("invalid_client", "Invalid client metadata"));
          }
        });
        res.on("error", () =>
          reject(
            new OAuthError(
              "invalid_client",
              "Client metadata could not be read",
            ),
          ),
        );
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("Client metadata timed out")),
      Math.max(1, deadline - Date.now()),
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", () =>
      reject(
        new OAuthError("invalid_client", "Client metadata could not be loaded"),
      ),
    );
    req.end();
  });
}
export function parseClientDocument(id: string, value: unknown): OAuthClient {
  metadataDocumentUrl(id);
  const parsed = clientMetadataSchema
    .extend({
      client_id: z.string().max(2048),
      client_name: clientMetadataSchema.shape.client_name.removeDefault(),
      token_endpoint_auth_method: z.literal("none").default("none"),
    })
    .safeParse(value);
  if (!parsed.success || parsed.data.client_id !== id)
    throw new OAuthError(
      "invalid_client",
      "Metadata clients must declare their exact client ID and use PKCE without a secret",
    );
  return {
    id,
    name: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
    authMethod: "none",
    secretHash: null,
    trust: "metadata-document",
  };
}
export async function resolveClient(id: string): Promise<OAuthClient> {
  if (id.startsWith("https://")) {
    try {
      return parseClientDocument(id, await fetchClientDocument(id));
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError(
        "invalid_client",
        "Client metadata could not be loaded",
      );
    }
  }
  const [client] = await sql<
    OAuthClient[]
  >`SELECT id,name,redirect_uris,auth_method,secret_hash FROM oauth_clients WHERE id=${id}`;
  if (!client) throw new OAuthError("invalid_client", "Unknown client");
  return { ...client, trust: "unverified" };
}
export async function registerClient(body: unknown) {
  const parsed = clientMetadataSchema.safeParse(body);
  if (!parsed.success)
    throw new OAuthError(
      "invalid_client_metadata",
      "Use authorization_code, code responses, and HTTPS or loopback redirect URIs",
    );
  const metadata = parsed.data,
    id = secret(),
    clientSecret =
      metadata.token_endpoint_auth_method === "none" ? null : secret();
  await sql`INSERT INTO oauth_clients(id,name,redirect_uris,auth_method,secret_hash) VALUES(${id},${metadata.client_name},${metadata.redirect_uris},${metadata.token_endpoint_auth_method},${clientSecret ? digest(clientSecret) : null})`;
  return {
    ...metadata,
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(clientSecret
      ? { client_secret: clientSecret, client_secret_expires_at: 0 }
      : {}),
  };
}
export async function authenticateClient(
  params: Record<string, string>,
  authorization?: string,
) {
  let id = params.client_id,
    supplied = params.client_secret,
    method = supplied === undefined ? "none" : "client_secret_post";
  if (authorization) {
    if (supplied !== undefined || !authorization.startsWith("Basic "))
      throw new OAuthError(
        "invalid_client",
        "Invalid client authentication",
        401,
      );
    const encoded = authorization.slice(6);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new OAuthError(
        "invalid_client",
        "Invalid client authentication",
        401,
      );
    const decoded = Buffer.from(encoded, "base64").toString("utf8"),
      colon = decoded.indexOf(":");
    if (colon < 0)
      throw new OAuthError(
        "invalid_client",
        "Invalid client authentication",
        401,
      );
    let basicId: string;
    try {
      basicId = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " "));
      supplied = decodeURIComponent(
        decoded.slice(colon + 1).replace(/\+/g, " "),
      );
    } catch {
      throw new OAuthError(
        "invalid_client",
        "Invalid client authentication",
        401,
      );
    }
    if (id && id !== basicId)
      throw new OAuthError("invalid_client", "Client IDs do not match", 401);
    id = basicId;
    method = "client_secret_basic";
  }
  if (!id)
    throw new OAuthError("invalid_client", "A client ID is required", 401);
  const client = await resolveClient(id);
  if (
    client.authMethod !== method ||
    (client.secretHash &&
      (!supplied || !equalHash(digest(supplied), client.secretHash)))
  )
    throw new OAuthError(
      "invalid_client",
      "Invalid client authentication",
      401,
    );
  return client;
}
