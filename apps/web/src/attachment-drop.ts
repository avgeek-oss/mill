type FileDragEvent = Event & {
  dataTransfer?: {
    types: readonly string[];
    files: Pick<FileList, "length" | "item">;
    dropEffect: string;
  } | null;
};

export function listenForAttachmentDrops(
  target: EventTarget,
  {
    canDrop,
    onFile,
    onDragging,
    onError,
  }: {
    canDrop: () => boolean;
    onFile: (file: File) => void;
    onDragging: (dragging: boolean) => void;
    onError: (message: string) => void;
  },
) {
  let depth = 0;
  let received = false;
  const available = () => !received && canDrop();
  const hasFiles = (event: FileDragEvent) =>
    event.dataTransfer?.types.includes("Files");
  const reset = () => {
    depth = 0;
    onDragging(false);
  };
  const enter = (event: Event) => {
    if (!hasFiles(event as FileDragEvent) || !available()) return;
    event.preventDefault();
    depth++;
    onDragging(true);
  };
  const over = (event: Event) => {
    const drag = event as FileDragEvent;
    if (!hasFiles(drag) || event.defaultPrevented) return;
    event.preventDefault();
    if (drag.dataTransfer)
      drag.dataTransfer.dropEffect = available() ? "copy" : "none";
  };
  const leave = () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) onDragging(false);
  };
  const drop = (event: Event) => {
    reset();
    const drag = event as FileDragEvent;
    if (!hasFiles(drag) || event.defaultPrevented) return;
    event.preventDefault();
    if (!available()) return;
    const files = drag.dataTransfer?.files;
    if (!files || files.length !== 1) {
      onError("Choose one file at a time.");
      return;
    }
    const file = files.item(0);
    if (!file) return;
    received = true;
    onFile(file);
  };
  target.addEventListener("dragenter", enter);
  target.addEventListener("dragover", over);
  target.addEventListener("dragleave", leave);
  target.addEventListener("drop", drop);
  target.addEventListener("dragend", reset);
  target.addEventListener("blur", reset);
  return () => {
    target.removeEventListener("dragenter", enter);
    target.removeEventListener("dragover", over);
    target.removeEventListener("dragleave", leave);
    target.removeEventListener("drop", drop);
    target.removeEventListener("dragend", reset);
    target.removeEventListener("blur", reset);
    reset();
  };
}
