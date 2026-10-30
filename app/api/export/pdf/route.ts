import { exportStoryboardPdf } from "@/lib/server/pdf-export";
import { boardSchema } from "@/lib/storyboard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    let rawBoard: unknown;
    let pdfBuffer: Uint8Array | undefined;
    const sceneImages = new Map<string, Uint8Array>();

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const boardStr = formData.get("board");
      if (typeof boardStr !== "string") {
        return Response.json({ error: "스토리보드 데이터가 누락되었습니다." }, { status: 400 });
      }
      rawBoard = JSON.parse(boardStr);

      const pdfFile = formData.get("pdf");
      if (pdfFile instanceof Blob) {
        pdfBuffer = new Uint8Array(await pdfFile.arrayBuffer());
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
      const json = await request.json();
      rawBoard = json.board ?? json;
    }

    const parseResult = boardSchema.safeParse(rawBoard);
    if (!parseResult.success) {
      return Response.json({ error: "유효하지 않은 스토리보드 데이터입니다." }, { status: 400 });
    }

    const pdfBytes = await exportStoryboardPdf({
      board: parseResult.data,
      pdfBuffer,
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
    console.error("PDF export error:", error);
    const message = error instanceof Error ? error.message : "PDF 내보내기 중 오류가 발생했습니다.";
    return Response.json({ error: message }, { status: 500 });
  }
}
