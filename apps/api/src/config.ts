import { z } from "zod";
const smtpFromSchema = z
  .string()
  .trim()
  .max(512)
  .refine((value) => {
    if (!value) return true;
    if (/\p{Cc}/u.test(value)) return false;
    const mailbox = value.match(/^[^<>]+<([^<>]+)>$/)?.[1] ?? value;
    return z.email().max(320).safeParse(mailbox.trim()).success;
  }, "Use an email address or a display name followed by <email address>");
const schema = z
  .object({
    DATABASE_URL: z
      .string()
      .url()
      .refine(
        (v) => ["postgres:", "postgresql:"].includes(new URL(v).protocol),
        "DATABASE_URL must use PostgreSQL",
      ),
    MILL_WEB_URL: z
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
    MILL_API_URL: z
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
    MILL_PASSWORD_VERIFY_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(8)
      .default(2),
    MILL_PASSWORD_VERIFY_QUEUE_LIMIT: z.coerce
      .number()
      .int()
      .min(0)
      .max(100)
      .default(16),
    MILL_SMTP_HOST: z.string().trim().max(253).default(""),
    MILL_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    MILL_SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    MILL_SMTP_USER: z.string().max(320).default(""),
    MILL_SMTP_PASSWORD: z.string().max(4096).default(""),
    MILL_SMTP_FROM: smtpFromSchema.default(""),
    MILL_S3_ENDPOINT: z
      .string()
      .trim()
      .default("")
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return (
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === "/" &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
          );
        } catch {
          return false;
        }
      }, "Use an HTTPS storage origin or loopback HTTP for development"),
    MILL_S3_REGION: z
      .string()
      .regex(/^[a-z0-9-]{1,80}$/)
      .default("auto"),
    MILL_S3_BUCKET: z
      .string()
      .trim()
      .default("")
      .refine(
        (value) => !value || /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value),
        "Use a valid bucket name",
      ),
    MILL_S3_ACCESS_KEY_ID: z.string().max(256).default(""),
    MILL_S3_SECRET_ACCESS_KEY: z.string().max(4096).default(""),
    PORT: z.coerce.number().int().min(1).max(65535).default(4321),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
  })
  .superRefine((value, ctx) => {
    const storageFields = [
      value.MILL_S3_ENDPOINT,
      value.MILL_S3_BUCKET,
      value.MILL_S3_ACCESS_KEY_ID,
      value.MILL_S3_SECRET_ACCESS_KEY,
    ];
    if (storageFields.some(Boolean) && !storageFields.every(Boolean))
      ctx.addIssue({
        code: "custom",
        path: ["MILL_S3_ENDPOINT"],
        message:
          "Configure the S3 endpoint, bucket, access key and secret access key together",
      });
    if (
      new URL(value.MILL_WEB_URL).origin === new URL(value.MILL_API_URL).origin
    )
      ctx.addIssue({
        code: "custom",
        path: ["MILL_API_URL"],
        message: "UI and API require separate origins",
      });
    if (Boolean(value.MILL_SMTP_HOST) !== Boolean(value.MILL_SMTP_FROM))
      ctx.addIssue({
        code: "custom",
        path: ["MILL_SMTP_HOST"],
        message: "Configure SMTP host and from address together",
      });
    if (Boolean(value.MILL_SMTP_USER) !== Boolean(value.MILL_SMTP_PASSWORD))
      ctx.addIssue({
        code: "custom",
        path: ["MILL_SMTP_USER"],
        message: "Configure SMTP user and password together",
      });
    if (
      !value.MILL_SMTP_HOST &&
      (value.MILL_SMTP_USER || value.MILL_SMTP_PASSWORD)
    )
      ctx.addIssue({
        code: "custom",
        path: ["MILL_SMTP_HOST"],
        message: "SMTP credentials require a configured host",
      });
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
