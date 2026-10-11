import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  Download01Icon,
  EyeIcon,
  File01Icon,
} from "@hugeicons/core-free-icons";
import {
  Button,
  FileUpload,
  QueryLoading,
  ResourceTable,
  TypographyParagraph,
  useOverlaySuspension,
} from "@avgeek-oss/design-system";
import { Spinner } from "@avgeek-oss/design-system/feedback/spinner";
import { Modal } from "@avgeek-oss/design-system/overlays/modal";
import { toast } from "@avgeek-oss/design-system/overlays/toast";
import type {
  Attachment,
  AttachmentConfiguration,
  AttachmentPage,
  AttachmentUpload as Upload,
} from "../../../packages/contracts/src/index.js";
import {
  ApiError,
  api,
  createRetryKey,
  errorText,
  hasOkAcknowledgement,
  isResponseObject,
  type User,
} from "./api.js";
import { listenForAttachmentDrops } from "./attachment-drop.js";
import { QueryFeedback } from "./query-feedback.js";
import { RelativeDateTime } from "./relative-date-time.js";
import { useSettingsMutation } from "./use-settings-mutation.js";

const PdfAttachmentPreview = lazy(() => import("./pdf-attachment-preview.js"));

export function useAttachmentConfiguration(sessionRevision: number) {
  const [configuration, setConfiguration] =
    useState<AttachmentConfiguration | null>(null);
  const [error, setError] = useState("");
  const run = useSettingsMutation(`attachments:${sessionRevision}`);
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await run((signal) =>
        api<AttachmentConfiguration>("/attachments/config", undefined, "GET", {
          signal,
          validateResponse: (value) =>
            isResponseObject(value) &&
            typeof value.enabled === "boolean" &&
            Number.isSafeInteger(value.maxBytes) &&
            Number(value.maxBytes) > 0 &&
            Array.isArray(value.contentTypes) &&
            value.contentTypes.every((type) => typeof type === "string"),
        }),
      );
      setConfiguration(result);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        setError(errorText(cause));
    }
  }, [run]);
  useEffect(() => {
    void load();
  }, [load, sessionRevision]);
  return { configuration, error, retry: load };
}

function attachmentResponse(value: unknown): value is Attachment {
  return (
    isResponseObject(value) &&
    typeof value.id === "string" &&
    typeof value.taskId === "string" &&
    typeof value.fileName === "string" &&
    typeof value.contentType === "string" &&
    Number.isSafeInteger(value.sizeBytes) &&
    typeof value.createdAt === "string"
  );
}
function pageResponse(value: unknown) {
  return (
    isResponseObject(value) &&
    Array.isArray(value.items) &&
    value.items.every(attachmentResponse) &&
    typeof value.hasMore === "boolean" &&
    (value.hasMore
      ? typeof value.nextCursor === "string" && value.nextCursor.length > 0
      : value.nextCursor === null)
  );
}
function signedResponse(value: unknown) {
  return (
    isResponseObject(value) &&
    typeof value.url === "string" &&
    validStorageUrl(value.url) &&
    typeof value.expiresAt === "string"
  );
}
function validStorageUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
function fileSize(size: number) {
  return size < 1024 * 1024
    ? `${Math.max(1, Math.round(size / 1024))} KB`
    : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentPreview({
  item,
  expanded = false,
}: {
  item: Attachment;
  expanded?: boolean;
}) {
  const run = useSettingsMutation(`preview:${item.id}`);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const result = await run((signal) =>
        api<{ url: string; expiresAt: string }>(
          `/tasks/${item.taskId}/attachments/${item.id}/download?preview=true`,
          undefined,
          "GET",
          { signal, validateResponse: signedResponse },
        ),
      );
      setUrl(result.url);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        setError(errorText(cause));
    }
  }, [run, item.id, item.taskId]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden rounded-lg bg-default ${expanded ? "h-[min(65vh,48rem)]" : "h-24 sm:h-28"}`}
    >
      {url ? (
        item.contentType === "application/pdf" ? (
          <Suspense fallback={<QueryLoading>Loading preview</QueryLoading>}>
            <PdfAttachmentPreview
              url={url}
              fileName={item.fileName}
              expanded={expanded}
              onError={() => {
                setUrl(null);
                setError("The preview could not be loaded. Try again.");
              }}
            />
          </Suspense>
        ) : (
          <img
            src={url}
            alt={item.fileName}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-contain"
            onError={() => {
              setUrl(null);
              setError("The preview could not be loaded. Try again.");
            }}
          />
        )
      ) : error ? (
        <Button variant="secondary" onPress={() => void load()}>
          Retry preview
        </Button>
      ) : (
        <HugeiconsIcon
          aria-hidden
          icon={File01Icon}
          className="size-8 text-muted"
        />
      )}
      <QueryFeedback message={error} />
    </div>
  );
}

type AttachmentSectionProps = {
  taskId: string;
  user: User;
  editable: boolean;
  sessionRevision: number;
  onChange: () => void;
};

export function TaskAttachmentSection(props: AttachmentSectionProps) {
  const { configuration, error, retry } = useAttachmentConfiguration(
    props.sessionRevision,
  );
  return (
    <>
      <QueryFeedback message={error} onRetry={() => void retry()} />
      {configuration?.enabled && (
        <TaskAttachments {...props} configuration={configuration} />
      )}
    </>
  );
}

function TaskAttachments({
  taskId,
  user,
  editable,
  configuration,
  sessionRevision,
  onChange,
}: AttachmentSectionProps & { configuration: AttachmentConfiguration }) {
  const overlay = useOverlaySuspension();
  const run = useSettingsMutation(`${taskId}:attachments:${user.id}`);
  const [page, setPage] = useState<AttachmentPage>({
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | undefined>();
  const [dropRevision, setDropRevision] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);
  const nextCursor = useRef<string | null>(null);
  const uploadJob = useRef<{
    file: File;
    upload: Upload;
    uploaded: boolean;
  } | null>(null);
  const uploadFile = useRef<File | null>(null);
  const [uploadKey] = useState(createRetryKey);
  const [completeKey] = useState(createRetryKey);
  const [deleteKey] = useState(createRetryKey);
  const writable = editable && user.role !== "viewer" && !overlay.isSuspended;

  const load = useCallback(
    async (more = false) => {
      setLoading(true);
      setError("");
      const captured = overlay.capture();
      try {
        const cursor = more ? nextCursor.current : null;
        const result = await run((signal) =>
          api<AttachmentPage>(
            `/tasks/${taskId}/attachments?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            undefined,
            "GET",
            { signal, validateResponse: pageResponse },
          ),
        );
        if (!captured()) return;
        if (result.items.some((item) => item.taskId !== taskId))
          throw new Error(
            "The server returned attachments for a different task.",
          );
        nextCursor.current = result.nextCursor;
        setPage((previous) => ({
          ...result,
          items: more
            ? [
                ...new Map(
                  [...previous.items, ...result.items].map((item) => [
                    item.id,
                    item,
                  ]),
                ).values(),
              ]
            : result.items,
        }));
        setReady(true);
      } catch (cause) {
        if (
          captured() &&
          !(cause instanceof DOMException && cause.name === "AbortError")
        )
          setError(errorText(cause));
      } finally {
        if (captured()) setLoading(false);
      }
    },
    [run, taskId, overlay.capture],
  );
  useEffect(() => {
    void load();
  }, [load, sessionRevision]);

  useEffect(
    () =>
      listenForAttachmentDrops(window, {
        canDrop: () =>
          writable &&
          !loading &&
          !busy &&
          !uploadOpen &&
          !uploadBusy &&
          !document.querySelector('[role="dialog"], [role="alertdialog"]'),
        onDragging: setDragging,
        onError: (message) => toast.danger(message),
        onFile: (file) => {
          setDroppedFile(file);
          setDropRevision((value) => value + 1);
          setUploadOpen(true);
        },
      }),
    [writable, loading, busy, uploadOpen, uploadBusy],
  );

  async function upload(file: File) {
    if (!writable)
      throw new Error("You no longer have permission to upload attachments.");
    const captured = overlay.capture();
    setUploadBusy(true);
    try {
      await run(async (signal) => {
        let job = uploadJob.current;
        const expired =
          job &&
          !job.uploaded &&
          Date.parse(job.upload.expiresAt) <= Date.now();
        if (uploadFile.current !== file || expired) {
          uploadKey.reset();
          completeKey.reset();
          uploadFile.current = file;
          uploadJob.current = null;
          job = null;
        }
        if (!job) {
          const bytes = await file.arrayBuffer();
          signal.throwIfAborted();
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const sha256 = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          const path = `/tasks/${taskId}/attachments/uploads`;
          const payload = {
            fileName: file.name,
            contentType: file.type,
            sizeBytes: file.size,
            sha256,
          };
          const signed = await api<Upload>(path, payload, "POST", {
            signal,
            headers: { "Idempotency-Key": uploadKey.forRequest(path, payload) },
            validateResponse: (value) =>
              isResponseObject(value) &&
              typeof value.attachmentId === "string" &&
              typeof value.uploadUrl === "string" &&
              validStorageUrl(value.uploadUrl) &&
              typeof value.expiresAt === "string" &&
              isResponseObject(value.headers) &&
              Object.values(value.headers).every(
                (header) => typeof header === "string",
              ),
          });
          job = { file, upload: signed, uploaded: false };
          uploadJob.current = job;
        }
        if (!job.uploaded) {
          const response = await fetch(job.upload.uploadUrl, {
            method: "PUT",
            headers: Object.fromEntries(
              Object.entries(job.upload.headers).filter(
                ([name]) => name.toLowerCase() !== "content-length",
              ),
            ),
            body: file,
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal,
          }).catch((cause: unknown) => {
            if (cause instanceof TypeError)
              throw new Error(
                "Attachment storage could not be reached. Check your connection and try again.",
              );
            throw cause;
          });
          if (!response.ok)
            throw new Error(
              "The file could not be uploaded. Check the storage CORS settings and try again.",
            );
          job.uploaded = true;
        }
        const path = `/tasks/${taskId}/attachments/${job.upload.attachmentId}/complete`;
        const saved = await api<{ attachment: Attachment }>(path, {}, "POST", {
          signal,
          headers: { "Idempotency-Key": completeKey.forRequest(path, {}) },
          validateResponse: (value) =>
            isResponseObject(value) &&
            attachmentResponse(value.attachment) &&
            value.attachment.taskId === taskId,
        }).catch((cause: unknown) => {
          if (cause instanceof ApiError && cause.code === "UPLOAD_EXPIRED") {
            uploadJob.current = null;
            uploadFile.current = null;
            uploadKey.reset();
            completeKey.reset();
          }
          throw cause;
        });
        if (!captured()) return;
        uploadJob.current = null;
        uploadFile.current = null;
        uploadKey.reset();
        completeKey.reset();
        setPage((previous) => ({
          ...previous,
          items: [
            saved.attachment,
            ...previous.items.filter((item) => item.id !== saved.attachment.id),
          ],
        }));
        setUploadOpen(false);
        setDroppedFile(undefined);
        toast.success("Attachment uploaded.");
        onChange();
      });
    } finally {
      setUploadBusy(false);
    }
  }

  async function download(item: Attachment) {
    const opened = window.open("about:blank", "_blank");
    if (opened) opened.opener = null;
    setDownloading(item.id);
    try {
      const result = await run((signal) =>
        api<{ url: string; expiresAt: string }>(
          `/tasks/${taskId}/attachments/${item.id}/download`,
          undefined,
          "GET",
          { signal, validateResponse: signedResponse },
        ),
      );
      if (opened) opened.location.replace(result.url);
      else
        throw new Error(
          "Allow downloads to open in a new tab, then try again.",
        );
    } catch (cause) {
      opened?.close();
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        toast.danger(errorText(cause));
    } finally {
      setDownloading(null);
    }
  }

  async function remove() {
    if (!deleting || !writable || busy) return;
    const captured = overlay.capture();
    const item = deleting;
    const path = `/tasks/${taskId}/attachments/${item.id}`;
    setBusy(true);
    setDeleteError("");
    try {
      await run((signal) =>
        api(path, {}, "DELETE", {
          signal,
          headers: {
            "Idempotency-Key": deleteKey.forRequest(path, {}, "DELETE"),
          },
          validateResponse: hasOkAcknowledgement,
        }),
      );
      if (!captured()) return;
      deleteKey.reset();
      setPage((previous) => ({
        ...previous,
        items: previous.items.filter((entry) => entry.id !== item.id),
      }));
      setDeleting(null);
      toast.success("Attachment deleted.");
      onChange();
    } catch (cause) {
      if (captured()) setDeleteError(errorText(cause));
    } finally {
      if (captured()) setBusy(false);
    }
  }

  function actions(item: Attachment) {
    return (
      <div className="flex shrink-0 items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          className="task-inline-action task-attachment-action"
          aria-label={`Preview ${item.fileName}`}
          onPress={() => {
            setPreviewing(item);
            setPreviewOpen(true);
          }}
        >
          <HugeiconsIcon aria-hidden icon={EyeIcon} size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          className="task-inline-action task-attachment-action"
          aria-label={`Download ${item.fileName}`}
          isPending={downloading === item.id}
          isDisabled={downloading !== null}
          onPress={() => void download(item)}
        >
          {downloading === item.id ? (
            <Spinner size="sm" aria-hidden />
          ) : (
            <HugeiconsIcon aria-hidden icon={Download01Icon} size={14} />
          )}
        </Button>
        {writable && (
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            className="task-inline-action task-attachment-action task-inline-action-delete"
            aria-label={`Delete ${item.fileName}`}
            onPress={() => {
              setDeleting(item);
              setDeleteError("");
            }}
          >
            <HugeiconsIcon aria-hidden icon={Delete02Icon} size={14} />
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-4" aria-busy={loading}>
      {dragging &&
        writable &&
        createPortal(
          <div className="pointer-events-none fixed inset-4 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-surface/95">
            <TypographyParagraph className="text-sm font-medium text-accent">
              Drop an image or PDF to attach it to this task
            </TypographyParagraph>
          </div>,
          document.body,
        )}
      <QueryFeedback
        message={error}
        onRetry={loading ? undefined : () => void load()}
      />
      {!ready && loading && (
        <QueryLoading className="sr-only">Loading attachments</QueryLoading>
      )}
      {!!page.items.length && page.items.length <= 4 && !page.hasMore ? (
        <div className="grid min-w-0 grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {page.items.map((item) => (
            <article
              key={item.id}
              aria-label={`Attachment ${item.fileName}`}
              className="grid min-w-0 gap-3 rounded-xl border border-separator bg-surface p-2"
            >
              <AttachmentPreview item={item} />
              <div className="flex min-w-0 items-start gap-1">
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium"
                    title={item.fileName}
                  >
                    {item.fileName}
                  </p>
                  <p className="text-xs text-muted">
                    {fileSize(item.sizeBytes)}
                  </p>
                </div>
                {actions(item)}
              </div>
            </article>
          ))}
        </div>
      ) : (
        !!page.items.length && (
          <ResourceTable
            ariaLabel="Task attachments"
            items={page.items}
            getRowKey={(item) => item.id}
            emptyTitle="No attachments"
            emptyDescription="Upload an image or PDF to this task."
            mobileLayout="stacked"
            columns={[
              {
                key: "name",
                header: "File",
                isRowHeader: true,
                cell: (item) => (
                  <span className="break-all">{item.fileName}</span>
                ),
              },
              {
                key: "size",
                header: "Size",
                cell: (item) => fileSize(item.sizeBytes),
              },
              {
                key: "date",
                header: "Uploaded",
                cell: (item) => (
                  <RelativeDateTime
                    value={item.createdAt}
                    dateFormat={user.dateFormat}
                    timeFormat={user.timeFormat}
                    timeZone={user.timeZone}
                  />
                ),
              },
              { key: "actions", header: "Actions", cell: actions },
            ]}
          />
        )
      )}
      {page.hasMore && (
        <Button
          variant="secondary"
          className="w-fit"
          isDisabled={loading}
          onPress={() => void load(true)}
        >
          Load more attachments
        </Button>
      )}
      {writable && (
        <Button
          variant="secondary"
          className="mb-4 w-fit min-[701px]:mb-0"
          isDisabled={loading || busy}
          onPress={() => {
            setDroppedFile(undefined);
            setUploadOpen(true);
          }}
        >
          Upload attachment
        </Button>
      )}
      <Modal
        isOpen={previewOpen && !overlay.isSuspended}
        onOpenChange={setPreviewOpen}
      >
        <Modal.Backdrop>
          <Modal.Container size="lg">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading className="min-w-0 break-all">
                  {previewing?.fileName}
                </Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>
              <Modal.Body>
                {previewing && !overlay.isSuspended && (
                  <AttachmentPreview
                    key={previewing.id}
                    item={previewing}
                    expanded
                  />
                )}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      <Modal
        isOpen={uploadOpen && writable}
        onOpenChange={(open) => {
          if (uploadBusy) return;
          setUploadOpen(open);
          if (!open) {
            setDroppedFile(undefined);
            uploadJob.current = null;
            uploadFile.current = null;
            uploadKey.reset();
            completeKey.reset();
          }
        }}
      >
        <Modal.Backdrop
          isDismissable={!uploadBusy}
          isKeyboardDismissDisabled={uploadBusy}
        >
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>Upload attachment</Modal.Heading>
                <Modal.CloseTrigger isDisabled={uploadBusy} />
              </Modal.Header>
              <Modal.Body>
                <FileUpload
                  key={droppedFile ? `drop-${dropRevision}` : "chooser"}
                  initialFile={droppedFile}
                  label="Choose file"
                  accept={configuration.contentTypes.join(",")}
                  maxSizeBytes={configuration.maxBytes}
                  description="Drag and drop an image or PDF here, or choose a file. Up to 20 MB."
                  onUpload={upload}
                />
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      <Modal
        isOpen={!!deleting && !overlay.isSuspended}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <Modal.Backdrop isDismissable={!busy} isKeyboardDismissDisabled={busy}>
          <Modal.Container>
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Heading>Delete attachment?</Modal.Heading>
                <Modal.CloseTrigger isDisabled={busy} />
              </Modal.Header>
              <Modal.Body>
                <TypographyParagraph className="text-sm">
                  Permanently delete{" "}
                  <span className="font-medium">{deleting?.fileName}</span> from
                  this task? This cannot be undone.
                </TypographyParagraph>
                <QueryFeedback message={deleteError} />
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => setDeleting(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger-soft"
                  isPending={busy}
                  isDisabled={!writable || busy}
                  onPress={() => void remove()}
                >
                  <span className="relative">
                    <span className={busy ? "invisible" : undefined}>
                      Delete attachment
                    </span>
                    {busy && (
                      <span className="absolute inset-0 inline-flex items-center justify-center gap-2">
                        <Spinner size="sm" aria-hidden />
                        Deleting…
                      </span>
                    )}
                  </span>
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}
