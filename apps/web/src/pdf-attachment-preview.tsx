import { useEffect, useRef } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfAttachmentPreview({
  url,
  fileName,
  onError,
}: {
  url: string;
  fileName: string;
  onError: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    let active = true;
    let loading: PDFDocumentLoadingTask | undefined;
    let rendering: RenderTask | undefined;
    async function render() {
      loading = getDocument({
        url,
        withCredentials: false,
        useWasm: false,
        isImageDecoderSupported: false,
      });
      const document = await loading.promise;
      const page = await document.getPage(1);
      if (!active || !canvas.current) return;
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(640 / natural.width, 352 / natural.height),
      });
      canvas.current.width = Math.ceil(viewport.width);
      canvas.current.height = Math.ceil(viewport.height);
      rendering = page.render({ canvas: canvas.current, viewport });
      await rendering.promise;
    }
    void render().catch(() => {
      if (active) error.current();
    });
    return () => {
      active = false;
      rendering?.cancel();
      void loading?.destroy();
    };
  }, [url]);
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={`First page of ${fileName}`}
      className="max-h-full max-w-full object-contain"
    />
  );
}
