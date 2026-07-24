import assert from "node:assert/strict";
import test from "node:test";

import {
  SmtpOperationTimeoutError,
  buildSmtpTransportOptions,
  resolveSmtpSecurityMode,
  smtpErrorMessage,
  withSmtpOperationTimeout,
} from "./smtpTransport";

test("legacy SMTP settings follow the standard 465 and 587 TLS modes", () => {
  assert.equal(resolveSmtpSecurityMode(undefined, 465, false), "auto");
  assert.equal(resolveSmtpSecurityMode(undefined, 587, true), "auto");
  assert.equal(resolveSmtpSecurityMode(undefined, 2465, true), "implicit-tls");
});

test("SMTP transport distinguishes implicit TLS from STARTTLS", () => {
  const implicit = buildSmtpTransportOptions({
    host: "smtp.example.com",
    port: 465,
    security: "auto",
    user: "user",
    password: "secret",
  });
  assert.equal(implicit.secure, true);
  assert.equal(implicit.requireTLS, false);
  assert.equal(implicit.ignoreTLS, false);

  const starttls = buildSmtpTransportOptions({
    host: "smtp.example.com",
    port: 587,
    security: "auto",
  });
  assert.equal(starttls.secure, false);
  assert.equal(starttls.requireTLS, true);
  assert.equal(starttls.ignoreTLS, false);
});

test("explicit plaintext SMTP disables STARTTLS", () => {
  const options = buildSmtpTransportOptions({
    host: "smtp.internal",
    port: 25,
    security: "none",
  });
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, false);
  assert.equal(options.ignoreTLS, true);
});

test("SMTP operations have a bounded deadline", async () => {
  let closed = false;
  const pending = new Promise<never>(() => undefined);
  await assert.rejects(
    withSmtpOperationTimeout(pending, 20, () => {
      closed = true;
    }),
    SmtpOperationTimeoutError,
  );
  assert.equal(closed, true);
});

test("OpenSSL protocol mismatch is presented as a TLS mode error", () => {
  const error = Object.assign(new Error("error:0A00010B:SSL routines::wrong version number"), {
    code: "ESOCKET",
  });
  assert.equal(
    smtpErrorMessage(error, 587, "implicit-tls"),
    "SMTP TLS 模式不匹配：465 端口应使用隐式 TLS，587 端口应使用 STARTTLS",
  );
});
