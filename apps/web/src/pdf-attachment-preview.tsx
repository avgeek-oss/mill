import { useEffect, useRef, useState } from "react";
import { Button, QueryLoading } from "@avgeek-oss/design-system";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfAttachmentPreview({
  url,
  fileName,
  expanded = false,
  onError,
}: {
  url: string;
  fileName: string;
  expanded?: boolean;
  onError: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [rendering, setRendering] = useState(false);
  const error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    let active = true;
    setDocument(null);
    setPageNumber(1);
    const loading = getDocument({
      url,
      withCredentials: false,
      useWasm: false,
      isImageDecoderSupported: false,
    });
    void loading.promise.then(
      (loaded) => {
        if (active) setDocument(loaded);
      },
      () => {
        if (active) error.current();
      },
    );
    return () => {
      active = false;
      void loading.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!document) return;
    const pdf = document;
    let active = true;
    let task: RenderTask | undefined;
    setRendering(true);
    async function render() {
      const page = await pdf.getPage(pageNumber);
      if (!active || !canvas.current) return;
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(
          (expanded ? 1600 : 640) / natural.width,
          (expanded ? 1800 : 352) / natural.height,
        ),
      });
      canvas.current.width = Math.ceil(viewport.width);
      canvas.current.height = Math.ceil(viewport.height);
      task = page.render({ canvas: canvas.current, viewport });
      await task.promise;
    }
    void render()
      .catch(() => {
        if (active) error.current();
      })
      .finally(() => {
        if (active) setRendering(false);
      });
    return () => {
      active = false;
      task?.cancel();
    };
  }, [document, pageNumber, expanded]);
  return (
    <div
      className="flex h-full min-w-0 w-full flex-col"
      aria-busy={!document || rendering}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <canvas
          ref={canvas}
          role="img"
          aria-label={
            expanded
              ? `Page ${pageNumber} of ${fileName}`
              : `First page of ${fileName}`
          }
          className={`max-h-full max-w-full object-contain ${rendering ? "invisible" : ""}`}
        />
        {(!document || rendering) && (
          <QueryLoading className="sr-only">Loading preview</QueryLoading>
        )}
      </div>
      {expanded && document && document.numPages > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-2 p-2">
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={pageNumber === 1 || rendering}
            className={pageNumber === 1 || rendering ? "text-muted" : undefined}
            aria-label="Previous PDF page"
            onPress={() => {
              if (!rendering) setPageNumber((page) => Math.max(1, page - 1));
            }}
          >
            Previous
          </Button>
          <span className="text-xs text-muted" aria-live="polite">
            Page {pageNumber} of {document.numPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={pageNumber === document.numPages || rendering}
            className={
              pageNumber === document.numPages || rendering
                ? "text-muted"
                : undefined
            }
            aria-label="Next PDF page"
            onPress={() => {
              if (!rendering)
                setPageNumber((page) => Math.min(document.numPages, page + 1));
            }}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
