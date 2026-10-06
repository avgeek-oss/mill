export type CaretRect = {
  left: number;
  top: number;
  bottom: number;
  visible: boolean;
};

export function textareaCaretRect(
  textarea: HTMLTextAreaElement,
  caret = textarea.selectionStart,
): CaretRect {
  const doc = textarea.ownerDocument;
  const view = doc.defaultView!;
  const computed = view.getComputedStyle(textarea);
  const bounds = textarea.getBoundingClientRect();
  const mirror = doc.createElement("div");
  const properties = [
    "boxSizing",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "fontStretch",
    "fontVariant",
    "fontFeatureSettings",
    "fontVariationSettings",
    "lineHeight",
    "letterSpacing",
    "wordSpacing",
    "textAlign",
    "textIndent",
    "textTransform",
    "direction",
    "tabSize",
  ] as const;
  for (const property of properties)
    mirror.style[property] = computed[property];
  const borderLeft = parseFloat(computed.borderLeftWidth) || 0;
  const borderRight = parseFloat(computed.borderRightWidth) || 0;
  const borderTop = parseFloat(computed.borderTopWidth) || 0;
  const borderBottom = parseFloat(computed.borderBottomWidth) || 0;
  const scrollbar = Math.max(
    0,
    textarea.offsetWidth - textarea.clientWidth - borderLeft - borderRight,
  );
  Object.assign(mirror.style, {
    position: "fixed",
    left: "0",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    boxSizing: "border-box",
    borderStyle: "solid",
    width: `${bounds.width}px`,
    height: "auto",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: "normal",
    paddingRight: `${(parseFloat(computed.paddingRight) || 0) + scrollbar}px`,
  });
  mirror.setAttribute("aria-hidden", "true");
  mirror.textContent = textarea.value.slice(0, caret);
  const marker = doc.createElement("span");
  marker.textContent = textarea.value.slice(caret) || "\u200b";
  mirror.append(marker);
  doc.body.append(mirror);
  const markerBounds = marker.getClientRects()[0];
  const mirrorBounds = mirror.getBoundingClientRect();
  const lineHeight = parseFloat(computed.lineHeight) || markerBounds.height;
  const top =
    bounds.top + markerBounds.top - mirrorBounds.top - textarea.scrollTop;
  const left =
    bounds.left + markerBounds.left - mirrorBounds.left - textarea.scrollLeft;
  mirror.remove();
  const viewport = view.visualViewport;
  let clipLeft = viewport?.offsetLeft ?? 0;
  let clipRight =
    (viewport?.offsetLeft ?? 0) + (viewport?.width ?? view.innerWidth);
  let clipTop = viewport?.offsetTop ?? 0;
  let clipBottom =
    (viewport?.offsetTop ?? 0) + (viewport?.height ?? view.innerHeight);
  let hidden = computed.visibility !== "visible" || computed.display === "none";
  for (
    let ancestor = textarea.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const style = view.getComputedStyle(ancestor);
    if (style.visibility !== "visible" || style.display === "none") {
      hidden = true;
      break;
    }
    if (style.display === "contents") continue;
    const rect = ancestor.getBoundingClientRect();
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
      const scale = ancestor.offsetWidth
        ? rect.width / ancestor.offsetWidth
        : 1;
      const start = rect.left + ancestor.clientLeft * scale;
      clipLeft = Math.max(clipLeft, start);
      clipRight = Math.min(clipRight, start + ancestor.clientWidth * scale);
    }
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
      const scale = ancestor.offsetHeight
        ? rect.height / ancestor.offsetHeight
        : 1;
      const start = rect.top + ancestor.clientTop * scale;
      clipTop = Math.max(clipTop, start);
      clipBottom = Math.min(clipBottom, start + ancestor.clientHeight * scale);
    }
  }
  return {
    left,
    top,
    bottom: top + lineHeight,
    visible:
      !hidden &&
      top + lineHeight > bounds.top + borderTop &&
      top < bounds.bottom - borderBottom &&
      left >= bounds.left + borderLeft &&
      left <= bounds.right - borderRight &&
      top >= clipTop &&
      top + lineHeight <= clipBottom &&
      left >= clipLeft &&
      left <= clipRight,
  };
}

export function mentionPopupPosition(
  caret: CaretRect,
  viewport: { left: number; top: number; width: number; height: number },
  popupHeight: number,
) {
  const margin = 8;
  const gap = 4;
  const width = Math.min(320, viewport.width - margin * 2);
  const right = viewport.left + viewport.width - margin;
  const bottom = viewport.top + viewport.height - margin;
  const below = Math.max(0, bottom - caret.bottom - gap);
  const above = Math.max(0, caret.top - gap - viewport.top - margin);
  const desiredHeight = Math.min(popupHeight, 256);
  const flip = below < desiredHeight && above > below;
  const maxHeight = Math.min(256, flip ? above : below);
  const height = Math.min(desiredHeight, maxHeight);
  return {
    left: Math.max(viewport.left + margin, Math.min(caret.left, right - width)),
    top: flip ? caret.top - gap - height : caret.bottom + gap,
    width,
    maxHeight,
  };
}
