import { exportStoryboardPdf } from "@/lib/server/pdf-export";
import { assertLocalAIRequest } from "@/lib/server/ai-config";
import { GenerationError } from "@/lib/generation-contract";
import { MAX_AI_PDF_BYTES, pdfSourceSchema, type PdfSource } from "@/lib/pdf-source";
import { PDFDocument } from "pdf-lib";
import { boardSchema } from "@/lib/storyboard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertLocalAIRequest(request);
    const ceiling = MAX_AI_PDF_BYTES + 20_000_000;
    if (Number(request.headers.get("content-length")) > ceiling) {
      return Response.json({ error: "내보낼 자료가 너무 큽니다. 이미지 크기를 줄여 주세요." }, { status: 413 });
    }
    if (!request.body) return Response.json({ error: "내보낼 자료가 없습니다." }, { status: 400 });
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > ceiling) {
          await reader.cancel();
          return Response.json({ error: "내보낼 자료가 너무 큽니다. 이미지 크기를 줄여 주세요." }, { status: 413 });
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type")! } });
    const contentType = request.headers.get("content-type") || "";
    let rawBoard: unknown;
    let pdfBuffer: Uint8Array | undefined;
    let attachedPdfSource: PdfSource | undefined;
    const sceneImages = new Map<string, Uint8Array>();

    if (contentType.includes("multipart/form-data")) {
      const formData = await body.formData();
      const boardStr = formData.get("board");
      if (typeof boardStr !== "string") {
        return Response.json({ error: "스토리보드 데이터가 누락되었습니다." }, { status: 400 });
      }
      rawBoard = JSON.parse(boardStr);

      const pdfFile = formData.get("pdf");
      if (pdfFile instanceof Blob) {
        const metadata = formData.get("pdfSource");
        const parsed = pdfSourceSchema.safeParse(typeof metadata === "string" ? JSON.parse(metadata) : null);
        if (!parsed.success || pdfFile.size >= MAX_AI_PDF_BYTES) {
          return Response.json({ error: "첨부 PDF의 원본 페이지 정보를 확인해 주세요." }, { status: 400 });
        }
        attachedPdfSource = parsed.data;
        pdfBuffer = new Uint8Array(await pdfFile.arrayBuffer());
        const pdf = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
        if (pdf.getPageCount() !== attachedPdfSource.pages.length) {
          return Response.json({ error: "첨부 PDF와 선택 페이지가 일치하지 않습니다." }, { status: 400 });
        }
      }

      // Collect attached scene images
      for (const [key, value] of formData.entries()) {
        if (key.startsWith("scene_image_") && value instanceof Blob) {
          const sceneId = key.replace("scene_image_", "");
          const buf = new Uint8Array(await value.arrayBuffer());
          sceneImages.set(sceneId, buf);
        }
      }
    } else {
      const json = await body.json();
      rawBoard = json.board ?? json;
    }

    const parseResult = boardSchema.safeParse(rawBoard);
    if (!parseResult.success) {
      return Response.json({ error: "유효하지 않은 스토리보드 데이터입니다." }, { status: 400 });
    }

    const pdfBytes = await exportStoryboardPdf({
      board: parseResult.data,
      pdfBuffer,
      attachedPdfSource,
      sceneImages,
    });

    return new Response(new Uint8Array(pdfBytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="storyboard.pdf"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof GenerationError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "내보낼 자료 형식을 확인해 주세요." }, { status: 400 });
    return Response.json({ error: "PDF 내보내기에 실패했습니다. 첨부 자료와 서버의 한글 글꼴 설치 상태를 확인해 주세요." }, { status: 500 });
  }
}
