import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Render the actual PDF, including in browsers without an embedded PDF plugin.
export default function PdfPreview({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [width, setWidth] = useState(600),
    [error, setError] = useState(""),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    setDocument(null);
    setPage(1);
    setError("");
    setBusy(true);
    import("pdfjs-dist")
      .then((pdf) => {
        if (!active) return;
        pdf.GlobalWorkerOptions.workerSrc = workerUrl;
        task = pdf.getDocument({ url });
        return task.promise;
      })
      .then((doc) => {
        if (active && doc) setDocument(doc);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setBusy(false);
        }
      });
    return () => {
      active = false;
      task?.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(200, entries[0].contentRect.width)),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true,
      render: RenderTask | undefined;
    setBusy(true);
    setError("");
    setText("");
    document
      .getPage(page)
      .then(async (pdfPage) => {
        if (!active || !canvas.current) return;
        const scale =
          Math.min(width, 1100) / pdfPage.getViewport({ scale: 1 }).width;
        const viewport = pdfPage.getViewport({ scale });
        const ratio = Math.min(devicePixelRatio || 1, 2);
        const element = canvas.current;
        element.width = Math.ceil(viewport.width * ratio);
        element.height = Math.ceil(viewport.height * ratio);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        render = pdfPage.render({
          canvas: element,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        });
        await render.promise;
        const content = await pdfPage.getTextContent();
        if (active) {
          setText(
            content.items
              .map((item) => ("str" in item ? item.str : ""))
              .join(" "),
          );
          setBusy(false);
        }
      })
      .catch((e) => {
        if (active && e.name !== "RenderingCancelledException") {
          setError(e.message);
          setBusy(false);
        }
      });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [document, page, width]);
  return (
    <section aria-label="PDF preview">
      <div className="row" style={{ margin: "12px 0" }}>
        <button
          disabled={!document || page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous page
        </button>
        <span>
          Page {page} / {document?.numPages || "…"}
        </span>
        <button
          disabled={!document || page >= document.numPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next page
        </button>
        <a href={url} target="_blank" rel="noreferrer">
          Open PDF file
        </a>
      </div>
      {busy && <p role="status">Rendering preview…</p>}
      {error && <p role="alert">{error}</p>}
      <div
        ref={host}
        style={{ width: "100%", overflow: "auto", background: "#d7d9dd" }}
      >
        <canvas
          ref={canvas}
          aria-label={`PDF page ${page}`}
          style={{ display: error ? "none" : "block", margin: "0 auto" }}
        />
      </div>
      {text && (
        <details>
          <summary>Text on this page</summary>
          <p style={{ whiteSpace: "pre-wrap" }}>{text}</p>
        </details>
      )}
    </section>
  );
}
