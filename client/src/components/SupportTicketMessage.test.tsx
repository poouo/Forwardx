import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SupportTicketMessage,
  TicketStatusBadge,
  ticketEventText,
  type SupportMessageView,
} from "./SupportTicketMessage";
import {
  getLanguagePreference,
  initializeLanguage,
  setLanguagePreference,
} from "@/i18n";
import { readSupportTicketFiles } from "@/lib/supportTicketFiles";
import { TICKET_STATUSES } from "@shared/supportTickets";

const message: SupportMessageView = {
  id: 1,
  authorId: 2,
  authorName: "Customer <&>",
  authorRole: "user",
  kind: "reply",
  visibility: "public",
  content: "<script>alert(1)</script>\nhttps://example.com",
  createdAt: 1000,
  attachments: [
    { id: 3, name: "<unsafe>.log", mime: "text/plain", size: 1024 },
  ],
};
test("support conversations escape content and filenames and expose real download controls", () => {
  const html = renderToStaticMarkup(
    <SupportTicketMessage
      message={message}
      onDownload={() => {}}
      downloading
    />,
  );
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Customer &lt;&amp;&gt;/);
  assert.match(html, /&lt;unsafe&gt;\.log/);
  assert.doesNotMatch(html, /<script|<iframe|dangerouslySetInnerHTML/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /<button[^>]*disabled=""/);
  const internal = renderToStaticMarkup(
    <SupportTicketMessage
      message={{ ...message, visibility: "internal", authorRole: "admin" }}
      onDownload={() => {}}
    />,
  );
  assert.match(internal, /内部备注/);
  assert.match(internal, /border-amber-500/);
});
test("support statuses, event timelines and staff-only labels translate into English", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    for (const status of TICKET_STATUSES) {
      const html = renderToStaticMarkup(<TicketStatusBadge status={status} />);
      assert.doesNotMatch(html, /\p{Script=Han}/u);
      assert.match(html, /shrink-0 whitespace-nowrap/);
    }
    assert.equal(
      ticketEventText(
        JSON.stringify({ action: "status", from: "open", to: "resolved" }),
      ),
      "Status changed: Open → Resolved",
    );
    assert.equal(
      ticketEventText(JSON.stringify({ action: "assignedTo", to: 4 }), {
        4: "Alice",
      }),
      "Assignee changed: Alice",
    );
    const html = renderToStaticMarkup(
      <SupportTicketMessage
        message={{
          ...message,
          authorName: "",
          visibility: "internal",
          authorRole: "admin",
          kind: "event",
          content: JSON.stringify({ action: "rating", to: 5 }),
        }}
        onDownload={() => {}}
      />,
    );
    assert.doesNotMatch(html, /\p{Script=Han}/u);
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});
test("attachment reading bounds uploads before encoding and preserves UTF-8 bytes", async () => {
  const file = new File(["日志\nexample"], "diagnostic.log", {
    type: "text/plain",
  });
  const [result] = await readSupportTicketFiles([file]);
  assert.equal(
    Buffer.from(result.base64, "base64").toString("utf8"),
    "日志\nexample",
  );
  await assert.rejects(() => readSupportTicketFiles([file], 3));
  await assert.rejects(() =>
    readSupportTicketFiles([new File(["x"], "bad.svg")]),
  );
  await assert.rejects(() =>
    readSupportTicketFiles([
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png"),
    ]),
  );
});
test("all batch dialog count pills stay horizontal and headers wrap by panel width", () => {
  const rules = readFileSync("client/src/pages/Rules.tsx", "utf8");
  const pills =
    rules.match(
      /className="inline-flex[^"\n]*self-start[^"\n]*rounded-full[^"\n]*"/g,
    ) || [];
  // The export dialog reports its count as inline wrapping text, so only these
  // five batch dialogs keep a fixed pill.
  assert.equal(pills.length, 5);
  for (const pill of pills) {
    assert.match(pill, /shrink-0/);
    assert.match(pill, /whitespace-nowrap/);
  }
  for (const label of [
    "规则筛选",
    "复制目标",
    "导入文件",
    "导入目标",
    "批量编辑内容",
  ]) {
    const index = rules.indexOf(`<Label>{translateText("${label}")}</Label>`);
    assert.ok(index > 0);
    const header = rules.slice(index - 180, index);
    assert.match(header, /flex flex-wrap items-start justify-between gap-2/);
    assert.match(header, /min-w-0 flex-1 basis-40/);
  }
});
test("export dialog states the exported rule count as wrapping text", () => {
  const rules = readFileSync("client/src/pages/Rules.tsx", "utf8");
  const title = rules.indexOf('{translateText("导出规则")}');
  assert.ok(title > 0);
  const dialog = rules.slice(title, title + 2500);
  assert.ok(dialog.includes("将导出 {0} 条{1}规则"), "export dialog must show the rule count");
  assert.ok(dialog.includes("请选择{0}"), "export dialog must prompt before a scope is chosen");
});
