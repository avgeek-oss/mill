import { createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fileTypeFromBuffer } from "file-type";
import {
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type AttachmentContentType,
} from "../../../../packages/contracts/src/index.js";
import { config } from "../config.js";
import { HttpError } from "../http.js";

export const URL_LIFETIME_SECONDS = 300;
export type StoredAttachment = Attachment & {
  state: "pending" | "ready";
  sha256: string | null;
  storageOrigin: string;
  storageBucket: string;
  uploadKey: string;
  objectKey: string;
  uploadExpiresAt: Date;
};
export const storageUnavailable = () =>
  new HttpError(
    503,
    "ATTACHMENT_STORAGE_UNAVAILABLE",
    "Attachment storage is unavailable. Try again.",
  );
export const invalidUpload = (message: string) =>
  new HttpError(422, "INVALID_ATTACHMENT", message);
const encodedFilename = (name: string) =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export async function verifyAttachmentBytes(
  attachment: Pick<StoredAttachment, "sizeBytes" | "sha256" | "contentType">,
  bytes: Uint8Array,
) {
  if (
    bytes.byteLength > MAX_ATTACHMENT_BYTES ||
    bytes.byteLength !== attachment.sizeBytes
  )
    throw invalidUpload(
      "The uploaded file size does not match the attachment.",
    );
  if (
    attachment.sha256 &&
    createHash("sha256").update(bytes).digest("hex") !== attachment.sha256
  )
    throw invalidUpload(
      "The uploaded file checksum does not match the attachment.",
    );
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
  if (detected?.mime !== attachment.contentType)
    throw invalidUpload(
      "Upload a valid image or PDF matching the selected file type.",
    );
}
type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};
export class AttachmentStorage {
  readonly origin: string;
  readonly bucket: string;
  private readonly client: S3Client;
  private completing = 0;
  constructor(configuration: StorageConfig) {
    this.origin = new URL(configuration.endpoint).origin;
    this.bucket = configuration.bucket;
    this.client = new S3Client({
      endpoint: configuration.endpoint,
      region: configuration.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 2,
    });
  }
  private assertLocation(row: {
    storageOrigin: string;
    storageBucket: string;
  }) {
    if (row.storageOrigin !== this.origin || row.storageBucket !== this.bucket)
      throw storageUnavailable();
  }
  async upload(row: StoredAttachment) {
    this.assertLocation(row);
    const expiresIn = Math.floor(
      (new Date(row.uploadExpiresAt).getTime() - Date.now()) / 1000,
    );
    if (expiresIn < 1)
      throw new HttpError(
        410,
        "UPLOAD_EXPIRED",
        "This upload expired. Start a new upload.",
      );
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: row.uploadKey,
        ContentType: row.contentType,
        ContentLength: row.sizeBytes,
      }),
      {
        expiresIn,
        signableHeaders: new Set(["content-type", "content-length"]),
      },
    );
    return {
      attachmentId: row.id,
      uploadUrl,
      headers: {
        "Content-Type": row.contentType,
        "Content-Length": String(row.sizeBytes),
      },
      expiresAt: new Date(row.uploadExpiresAt).toISOString(),
    };
  }
  async complete(row: StoredAttachment, verifiedKey: string) {
    this.assertLocation(row);
    if (this.completing >= 2)
      throw new HttpError(
        429,
        "ATTACHMENT_VERIFICATION_BUSY",
        "Attachment verification is busy. Try again.",
        { "Retry-After": "2" },
      );
    this.completing++;
    const signal = AbortSignal.timeout(20_000);
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: row.uploadKey }),
        { abortSignal: signal },
      );
      if (
        head.ContentLength !== row.sizeBytes ||
        head.ContentType !== row.contentType
      )
        throw invalidUpload(
          "The uploaded size or file type does not match the attachment.",
        );
      if (!head.ETag) throw storageUnavailable();
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: row.uploadKey,
          IfMatch: head.ETag,
        }),
        { abortSignal: signal },
      );
      if (!object.Body) throw storageUnavailable();
      const stream = object.Body as AsyncIterable<Uint8Array> & {
        destroy?: () => void;
      };
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for await (const chunk of stream) {
          length += chunk.byteLength;
          if (length > Math.min(row.sizeBytes, MAX_ATTACHMENT_BYTES))
            throw invalidUpload("The uploaded file exceeds its reserved size.");
          chunks.push(chunk);
        }
      } finally {
        stream.destroy?.();
      }
      const bytes = Buffer.concat(chunks);
      await verifyAttachmentBytes(row, bytes);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: verifiedKey,
          Body: bytes,
          ContentType: row.contentType,
          ContentLength: bytes.byteLength,
          ContentDisposition: `attachment; filename*=UTF-8''${encodedFilename(row.fileName)}`,
          CacheControl: "private, no-store",
          Metadata: {
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404)
        throw invalidUpload(
          "Upload the file before completing the attachment.",
        );
      if (status === 412)
        throw invalidUpload(
          "The upload changed during verification. Try again.",
        );
      throw storageUnavailable();
    } finally {
      this.completing--;
    }
  }
  async download(row: StoredAttachment, preview = false) {
    this.assertLocation(row);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: row.objectKey,
        ResponseContentType: row.contentType as AttachmentContentType,
        ResponseContentDisposition: `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename(row.fileName)}`,
        ResponseCacheControl: "private, no-store",
      }),
      { expiresIn: URL_LIFETIME_SECONDS },
    );
    return {
      url,
      expiresAt: new Date(
        Date.now() + URL_LIFETIME_SECONDS * 1000,
      ).toISOString(),
    };
  }
  async delete(row: {
    storageOrigin: string;
    storageBucket: string;
    objectKey: string;
  }) {
    this.assertLocation(row);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: row.objectKey }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
    } catch {
      throw storageUnavailable();
    }
  }
}
let cached: { fingerprint: string; storage: AttachmentStorage } | undefined;
export function attachmentStorage(): AttachmentStorage | undefined {
  const c = config();
  if (!c.MILL_S3_BUCKET) return undefined;
  const configuration = {
    endpoint: c.MILL_S3_ENDPOINT,
    region: c.MILL_S3_REGION,
    bucket: c.MILL_S3_BUCKET,
    accessKeyId: c.MILL_S3_ACCESS_KEY_ID,
    secretAccessKey: c.MILL_S3_SECRET_ACCESS_KEY,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(configuration))
    .digest("hex");
  if (cached?.fingerprint !== fingerprint)
    cached = { fingerprint, storage: new AttachmentStorage(configuration) };
  return cached.storage;
}
export function requireAttachmentStorage() {
  const storage = attachmentStorage();
  if (!storage)
    throw new HttpError(
      503,
      "ATTACHMENTS_DISABLED",
      "Attachments are not configured for this installation.",
    );
  return storage;
}
