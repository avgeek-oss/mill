import { z } from "zod";
import { isIP } from "node:net";
const schema = z.object({
  MILL_TRUSTED_PROXY_IPS: z
    .string()
    .default("")
    .refine(
      (v) => !v || v.split(",").every((ip) => Boolean(isIP(ip.trim()))),
      "Use comma-separated trusted proxy IP addresses",
    ),
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (v) => ["postgres:", "postgresql:"].includes(new URL(v).protocol),
      "DATABASE_URL must use PostgreSQL",
    ),
  MILL_BASE_URL: z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === "/" &&
        (u.protocol === "https:" ||
          (u.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
      );
    }, "Use an HTTPS origin or a loopback HTTP development origin"),
  MILL_SECRET: z.string().min(32),
  PORT: z.coerce.number().int().min(1).max(65535).default(4321),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});
export function config() {
  return schema.parse(process.env);
}
export function validateConfiguration() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\n"),
    );
  return parsed.data;
}
