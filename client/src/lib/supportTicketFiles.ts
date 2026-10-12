import {
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENT_MAX_COUNT,
  type TicketAttachmentInput,
} from "@shared/supportTickets";
import { t } from "@/i18n";

export async function readSupportTicketFiles(
  files: File[],
  existingCount = 0,
): Promise<TicketAttachmentInput[]> {
  if (
    files.length + existingCount > TICKET_ATTACHMENT_MAX_COUNT ||
    files.some(
      (f) =>
        !f.size ||
        f.size > TICKET_ATTACHMENT_MAX_BYTES ||
        !/\.(png|jpe?g|webp|pdf|txt|log)$/i.test(f.name),
    )
  ) {
    throw new Error(
      t(
        "附件仅支持 PNG/JPEG/WebP、PDF 和 UTF-8 TXT/LOG，每个不超过 2 MB，每次最多 3 个",
      ),
    );
  }
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 16384)
        binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
      return {
        name: file.name.slice(0, 160),
        mime: file.type || "application/octet-stream",
        base64: btoa(binary),
      };
    }),
  );
}

export function downloadSupportTicketFile(file: {
  base64: string;
  mime: string;
  name: string;
}) {
  const binary = atob(file.base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name.replace(/[\\/<>:"|?*\x00-\x1f]/g, "_");
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
