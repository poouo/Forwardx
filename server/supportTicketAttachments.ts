import { TRPCError } from "@trpc/server";
import {
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENT_MAX_COUNT,
  type TicketAttachmentInput,
} from "../shared/supportTickets";

export function validateTicketAttachments(files: TicketAttachmentInput[] = []) {
  const invalid = () =>
    new TRPCError({
      code: "BAD_REQUEST",
      message:
        "附件仅支持 PNG/JPEG/WebP、PDF 和 UTF-8 TXT/LOG，每个不超过 2 MB，每次最多 3 个",
    });
  if (files.length > TICKET_ATTACHMENT_MAX_COUNT) throw invalid();
  return files.map((file) => {
    const name = file.name
      .replace(/[\\/<>:"|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "_")
      .slice(0, 160)
      .trim();
    if (
      !name ||
      file.base64.length > Math.ceil(TICKET_ATTACHMENT_MAX_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)
    )
      throw invalid();
    const bytes = Buffer.from(file.base64, "base64");
    if (
      !bytes.length ||
      bytes.length > TICKET_ATTACHMENT_MAX_BYTES ||
      bytes.toString("base64") !== file.base64
    )
      throw invalid();
    const extension = name.split(".").pop()?.toLowerCase();
    let mime = "";
    if (
      extension === "png" &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mime = "image/png";
    if (
      ["jpg", "jpeg"].includes(extension || "") &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255
    )
      mime = "image/jpeg";
    if (
      extension === "webp" &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    )
      mime = "image/webp";
    if (extension === "pdf" && bytes.toString("ascii", 0, 5) === "%PDF-")
      mime = "application/pdf";
    if (extension === "txt" || extension === "log") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw invalid();
      }
      if (bytes.includes(0)) throw invalid();
      mime = "text/plain";
    }
    if (!mime) throw invalid();
    return { name, mime, size: bytes.length, base64: file.base64 };
  });
}
