import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Dialog,
  ErrorMessage,
  FileField,
  Link,
  Widget,
} from "@mill/web-design-system";
import { HugeiconsIcon } from "@hugeicons/react";
import { FileExportIcon, FileImportIcon } from "@hugeicons/core-free-icons";
import { api, createRetryKey, errorText } from "./api.js";
import { Check } from "./icons.js";
import { PageHeading } from "./page-heading.js";

type Counts = {
  boards: number;
  tasks: number;
  comments: number;
  members: number;
};
function importResponse(value: unknown): value is { imported: Counts } {
  if (!object(value) || !object(value.imported)) return false;
  const counts = value.imported;
  return ["boards", "tasks", "comments", "members"].every((field) => {
    const count = counts[field];
    return (
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    );
  });
}
type Selection = { name: string; payload: unknown; counts: Counts };
const portableLimit = 32 * 1024 * 1024;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validatePortable(value: unknown): Counts {
  if (
    !object(value) ||
    value.format !== "mill-portable" ||
    (value.version !== 1 && value.version !== 2)
  )
    throw new Error("Choose a Mill export file in version 1 or 2 format.");
  if (
    !object(value.workspace) ||
    typeof value.workspace.name !== "string" ||
    !value.workspace.name.trim() ||
    typeof value.exportedAt !== "string" ||
    Number.isNaN(Date.parse(value.exportedAt))
  )
    throw new Error("This file is missing the Mill export information.");
  const limits = {
    members: 10000,
    boards: 100,
    columns: 5000,
    tasks: 50000,
    comments: 100000,
  };
  for (const [name, limit] of Object.entries(limits)) {
    const records = value[name];
    if (
      !Array.isArray(records) ||
      records.length > limit ||
      records.some(
        (record) =>
          !object(record) ||
          typeof record.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            record.id,
          ),
      )
    )
      throw new Error(`This file does not contain a valid ${name} collection.`);
  }
  return {
    boards: (value.boards as unknown[]).length,
    tasks: (value.tasks as unknown[]).length,
    comments: (value.comments as unknown[]).length,
    members: (value.members as unknown[]).length,
  };
}

function DataWidget({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Widget role="region" aria-label={title} className="min-w-0">
      <Widget.Header>
        <Widget.Title icon={icon} help={false}>
          <h2 className="text-sm font-medium">{title}</h2>
        </Widget.Title>
      </Widget.Header>
      <Widget.Content>
        <div className="content-grid min-w-0">{children}</div>
      </Widget.Content>
    </Widget>
  );
}
function ImportCounts({ counts }: { counts: Counts }) {
  return (
    <dl className="grid grid-cols-2 gap-4">
      {(
        [
          ["boards", "Boards"],
          ["tasks", "Tasks"],
          ["comments", "Comments"],
          ["members", "Member records"],
        ] as const
      ).map(([key, label]) => (
        <div key={key} className="grid gap-1">
          <dt className="text-sm text-muted">{label}</dt>
          <dd className="m-0 text-sm font-medium tabular-nums">
            {counts[key].toLocaleString()}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DataSettings({ onRefresh }: { onRefresh: () => void }) {
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const fileRead = useRef(0);
  const [filename, setFilename] = useState("");
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportPending = useRef(false);
  const [exportError, setExportError] = useState("");
  const [exported, setExported] = useState(false);
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const importPending = useRef(false);
  const [importError, setImportError] = useState("");
  const [imported, setImported] = useState<Counts | null>(null);
  const [retryKey] = useState(createRetryKey);
  useEffect(() => {
    document.title = "Export and import · Mill";
    return () => {
      fileRead.current++;
    };
  }, []);

  async function download() {
    if (exportPending.current) return;
    exportPending.current = true;
    setExporting(true);
    setExportError("");
    setExported(false);
    try {
      const data = await api("/export");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `mill-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setExported(true);
    } catch (error) {
      setExportError(errorText(error));
    } finally {
      exportPending.current = false;
      setExporting(false);
    }
  }
  async function selectFile(file?: File) {
    const sequence = ++fileRead.current;
    setSelection(null);
    setFilename(file?.name ?? "");
    setFileError("");
    setReading(false);
    if (!file) return;
    if (file.size > portableLimit) {
      setFileError("Choose a file no larger than 32 MiB.");
      return;
    }
    setReading(true);
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        throw new Error(
          "This file is not valid JSON. Choose a Mill export file.",
        );
      }
      const counts = validatePortable(payload);
      if (sequence === fileRead.current)
        setSelection({ name: file.name, payload, counts });
    } catch (error) {
      if (sequence === fileRead.current) setFileError(errorText(error));
    } finally {
      if (sequence === fileRead.current) setReading(false);
    }
  }
  function beginImport() {
    if (!selection || reading || importPending.current) return;
    setImportError("");
    setImported(null);
    setOpen(true);
  }
  async function importData() {
    if (!selection || importPending.current || imported) return;
    importPending.current = true;
    setImporting(true);
    setImportError("");
    try {
      const result = await api<{ imported: Counts }>(
        "/import",
        selection.payload,
        "POST",
        {
          validateResponse: importResponse,
          headers: {
            "Idempotency-Key": retryKey.forRequest(
              "/import",
              selection.payload,
            ),
          },
        },
      );
      setImported(result.imported);
      retryKey.reset();
      onRefresh();
    } catch (error) {
      setImportError(errorText(error));
    } finally {
      importPending.current = false;
      setImporting(false);
    }
  }
  function close() {
    if (!importPending.current) {
      retryKey.reset();
      setOpen(false);
    }
  }
  return (
    <section className="settings-page">
      <PageHeading
        title="Export and import"
        icon={<HugeiconsIcon icon={FileExportIcon} size={24} />}
      />
      <div className="content-grid min-w-0 lg:grid-cols-2 lg:items-start">
        <DataWidget
          title="Workspace export"
          icon={<HugeiconsIcon icon={FileExportIcon} size={16} />}
        >
          <p className="text-sm text-muted">
            Download boards, tasks, comments, and member details. Account
            secrets and credentials are excluded.
          </p>
          <ErrorMessage>{exportError}</ErrorMessage>
          {exporting && (
            <p role="status" className="text-sm text-muted">
              Preparing the workspace export…
            </p>
          )}
          {exported && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-success"
            >
              <Check />
              Workspace export downloaded.
            </p>
          )}
          <div>
            <Button
              variant="secondary"
              isDisabled={exporting}
              onPress={() => void download()}
            >
              <HugeiconsIcon icon={FileExportIcon} size={16} />
              {exporting
                ? "Preparing export…"
                : exportError
                  ? "Retry export"
                  : "Download export"}
            </Button>
          </div>
          <p className="text-sm text-muted">
            Mill export files support up to 100 boards and 32 MiB. Larger
            workspaces need a database backup, which also preserves accounts and
            history. Follow the{" "}
            <Link
              href="/guides/backup.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              backup and recovery guide
            </Link>
            .
          </p>
        </DataWidget>
        <DataWidget
          title="Import workspace data"
          icon={<HugeiconsIcon icon={FileImportIcon} size={16} />}
        >
          <p className="text-sm text-muted">
            Add data from a Mill export file. Your administrator account keeps
            access. Make a database backup first.
          </p>
          <FileField
            ref={fileInput}
            id={inputId}
            label="Choose Mill export"
            accept="application/json,.json"
            disabled={reading || importing}
            description="JSON file, up to 32 MiB and 100 boards per file."
            error={fileError}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void selectFile(file);
            }}
          />
          {filename && (
            <div className="grid min-w-0 gap-1">
              <span className="text-sm text-muted">Selected file</span>
              <span className="break-all text-sm font-medium">{filename}</span>
            </div>
          )}
          {reading && (
            <p role="status" className="text-sm text-muted">
              Checking the selected file…
            </p>
          )}
          {selection && !reading && (
            <p className="text-sm text-muted">
              File checked. Review the import before continuing.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              isDisabled={!selection || reading || importing}
              onPress={beginImport}
            >
              <HugeiconsIcon icon={FileImportIcon} size={16} />
              Import
            </Button>
            {filename && (
              <Button
                variant="secondary"
                isDisabled={importing}
                onPress={() => {
                  retryKey.reset();
                  if (fileInput.current) fileInput.current.value = "";
                  void selectFile();
                }}
              >
                Clear selection
              </Button>
            )}
          </div>
        </DataWidget>
      </div>
      {open && selection && (
        <Dialog
          open
          title={imported ? "Import completed" : "Import workspace data?"}
          onClose={close}
          isDismissDisabled={importing}
          size="sm"
          footer={
            imported ? (
              <Button onPress={close}>Done</Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  isDisabled={importing}
                  onPress={close}
                >
                  Cancel
                </Button>
                <Button
                  isDisabled={importing}
                  onPress={() => void importData()}
                >
                  {importing
                    ? "Importing…"
                    : importError
                      ? "Retry import"
                      : "Import"}
                </Button>
              </>
            )
          }
        >
          <div className="content-grid min-w-0">
            <p className="break-all text-sm font-medium">{selection.name}</p>
            <ErrorMessage>{importError}</ErrorMessage>
            {imported ? (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-success"
              >
                <Check />
                Import completed. Your workspace data is ready.
              </p>
            ) : (
              <p className="text-sm text-muted">
                Mill adds these boards to your workspace. Existing data and your
                administrator access are kept.
              </p>
            )}
            <ImportCounts counts={imported ?? selection.counts} />
            {importing && (
              <p role="status" className="text-sm text-muted">
                Importing the selected file. Keep this dialog open.
              </p>
            )}
            {importError && (
              <p className="text-sm text-muted">
                Your file is still selected. Retry the import or cancel to
                choose another file.
              </p>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}
