// Separate processes deliberately share only the database, never JS locks.
import { connectDatabase, closeDatabase } from "./dbRuntime";
import { createPaymentOrder, purchasePlanWithBalance } from "./repositories/billingRepository";
import { createForwardRule } from "./repositories/forwardRuleRepository";

await connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
process.send?.({ ready: true });
process.once("message", async (input: any) => {
  try {
    let value;
    if (input.operation === "balance") value = await purchasePlanWithBalance(input.userId, 1);
    else if (input.operation === "order") value = await createPaymentOrder({
      outTradeNo: `race-${input.userId}`, userId: input.userId, provider: "stripe", paymentType: "stripe",
      subject: "stock", amountCents: 100, planId: 1, orderType: "plan",
    });
    else value = await createForwardRule({
      hostId: 1, userId: input.userId, name: "race", forwardType: "realm", protocol: "both",
      sourcePort: 20000 + input.userId, targetIp: "127.0.0.1", targetPort: 80,
    });
    process.send?.({ ok: true, value });
  } catch (error) {
    process.send?.({ ok: false, error: String(error) });
  } finally {
    await closeDatabase();
    process.disconnect();
  }
});
