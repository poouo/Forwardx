import assert from "node:assert/strict";
import test from "node:test";

import {
  DOWNLOAD_LINK_CLEANUP_DELAY_MS,
  DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS,
  MAX_DATA_URL_FALLBACK_LENGTH,
  downloadTextFile,
  sanitizeDownloadFilename,
  type FileDownloadRuntime,
} from "./fileDownload";

type ScheduledTask = { callback: () => void; delayMs: number };

function createRuntime(overrides: Partial<FileDownloadRuntime> = {}) {
  const scheduled: ScheduledTask[] = [];
  const links: Array<{
    href: string;
    download: string;
    rel: string;
    style: { display: string };
    click: () => void;
    removed: boolean;
  }> = [];
  const revoked: string[] = [];
  const runtime: FileDownloadRuntime = {
    createBlob: (content, mimeType) => ({ content, mimeType }),
    createObjectUrl: () => "blob:forwardx-backup",
    revokeObjectUrl: (url) => revoked.push(url),
    createLink: () => {
      const link = {
        href: "",
        download: "",
        rel: "",
        style: { display: "" },
        click: () => undefined,
        removed: false,
      };
      links.push(link);
      return link;
    },
    appendLink: () => undefined,
    removeLink: (link) => {
      const tracked = links.find((candidate) => candidate === link);
      if (tracked) tracked.removed = true;
    },
    schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    ...overrides,
  };
  return { runtime, scheduled, links, revoked };
}

test("keeps Safari blob URLs alive until the browser has consumed the download", () => {
  const harness = createRuntime();

  const method = downloadTextFile(
    "forwardx-backup?.fwxbak",
    "encrypted-content",
    "application/json;charset=utf-8",
    harness.runtime,
  );

  assert.equal(method, "blob");
  assert.equal(harness.links.length, 1);
  assert.equal(harness.links[0].href, "blob:forwardx-backup");
  assert.equal(harness.links[0].download, "forwardx-backup_.fwxbak");
  assert.equal(harness.links[0].removed, false);
  assert.deepEqual(harness.revoked, []);

  harness.scheduled.find((task) => task.delayMs === DOWNLOAD_LINK_CLEANUP_DELAY_MS)?.callback();
  assert.equal(harness.links[0].removed, true);
  assert.deepEqual(harness.revoked, []);

  harness.scheduled.find((task) => task.delayMs === DOWNLOAD_OBJECT_URL_REVOKE_DELAY_MS)?.callback();
  assert.deepEqual(harness.revoked, ["blob:forwardx-backup"]);
});

test("falls back to a data URL when Safari rejects the blob URL", () => {
  const harness = createRuntime({
    createObjectUrl: () => {
      throw new DOMException("The string did not match the expected pattern.", "SyntaxError");
    },
  });

  const method = downloadTextFile("backup.fwxbak", "a b", "text/plain;charset=utf-8", harness.runtime);

  assert.equal(method, "data");
  assert.equal(harness.links.length, 1);
  assert.equal(harness.links[0].href, "data:text/plain;charset=utf-8,a%20b");
});

test("preserves Unicode content in the data URL fallback", () => {
  const harness = createRuntime({
    createObjectUrl: () => {
      throw new Error("blob unavailable");
    },
  });

  assert.equal(downloadTextFile("日志.txt", "中文日志", "text/plain;charset=utf-8", harness.runtime), "data");
  const encodedContent = harness.links[0].href.split(",", 2)[1];
  assert.equal(decodeURIComponent(encodedContent), "中文日志");
});

test("falls back after a blob link click fails", () => {
  let clickCount = 0;
  const harness = createRuntime({
    createLink: () => {
      const link = {
        href: "",
        download: "",
        rel: "",
        style: { display: "" },
        click: () => {
          clickCount += 1;
          if (clickCount === 1) throw new Error("Safari blocked the blob navigation");
        },
        removed: false,
      };
      harness.links.push(link);
      return link;
    },
  });

  assert.equal(downloadTextFile("backup.fwxbak", "payload", "text/plain", harness.runtime), "data");
  assert.equal(clickCount, 2);
  assert.equal(harness.links.length, 2);
  assert.deepEqual(harness.revoked, ["blob:forwardx-backup"]);
});

test("reports an actionable error when both browser download paths fail", () => {
  const harness = createRuntime({
    createObjectUrl: () => {
      throw new Error("blob unavailable");
    },
    createLink: () => {
      throw new Error("link unavailable");
    },
  });

  assert.throws(
    () => downloadTextFile("backup.fwxbak", "payload", "text/plain", harness.runtime),
    /浏览器未能保存文件，请检查下载权限后重试/,
  );
});

test("does not expand a large backup into a memory-heavy data URL", () => {
  const harness = createRuntime({
    createObjectUrl: () => {
      throw new Error("blob unavailable");
    },
  });

  assert.throws(
    () => downloadTextFile("backup.fwxbak", "x".repeat(MAX_DATA_URL_FALLBACK_LENGTH + 1), "application/json", harness.runtime),
    /浏览器未能保存文件，请检查下载权限后重试/,
  );
  assert.equal(harness.links.length, 0);
});

test("normalizes MIME types before using a data URL", () => {
  const harness = createRuntime({
    createObjectUrl: () => {
      throw new Error("blob unavailable");
    },
  });

  downloadTextFile("backup.txt", "payload", "text/plain,malformed", harness.runtime);
  assert.equal(harness.links[0].href, "data:application/octet-stream,payload");
});

test("normalizes unsafe or empty download filenames", () => {
  assert.equal(sanitizeDownloadFilename("  forwardx:backup/?.fwxbak.  "), "forwardx_backup__.fwxbak");
  assert.equal(sanitizeDownloadFilename("..."), "forwardx-download.txt");
});

test("can be imported without a DOM and reports that downloads require a browser", () => {
  assert.throws(
    () => downloadTextFile("backup.fwxbak", "payload"),
    /当前环境不支持浏览器文件下载/,
  );
});
