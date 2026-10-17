import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { httpLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "@/lib/trpc";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { ruleOwnerOptionIds, userOptionDetail, userOptionLabel } from "@/lib/userSelection";
import UserSelect from "./UserSelect";

test("user options distinguish duplicate names with remarks, username, email and ID", () => {
  const user = { id: 12, username: "customer", name: "Friend", email: "friend@example.test", displayRemark: "备注" };
  assert.equal(userOptionLabel(user), "Friend · 备注");
  assert.equal(userOptionDetail(user), "customer · friend@example.test · #12");
  assert.equal(userOptionDetail({ id: 1, username: "mail@example.test", email: "mail@example.test" }), "#1");
});

test("visible rule owner lookup is bounded, deduplicated and includes the selected creation owner", () => {
  assert.deepEqual(ruleOwnerOptionIds([{ userId: 4 }, { userId: 4 }, { userId: null }, { userId: -1 }, { userId: 2 }], 10), [2, 4, 10]);
  const ids = ruleOwnerOptionIds(Array.from({ length: 1000 }, (_, index) => ({ userId: index + 1 })), 2000);
  assert.equal(ids.length, 100);
  assert.ok(ids.includes(2000));
});

test("selector retains its selected label outside search results and has accessible bilingual triggers", async () => {
  const language = getLanguagePreference();
  try {
    for (const locale of ["zh-CN", "en"] as const) {
      setLanguagePreference(locale);
      await initializeLanguage();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(getQueryKey(trpc.auth.me, undefined, "query"), { id: 1, role: "admin" });
      queryClient.setQueryData(getQueryKey(trpc.users.optionsByIds, { ids: [12] }, "query"), [{ id: 12, username: "customer", name: "Friend", displayRemark: "VIP" }]);
      const client = trpc.createClient({ links: [httpLink({ url: "http://unused.test/api/trpc", transformer: superjson })] });
      const html = renderToStaticMarkup(<trpc.Provider client={client} queryClient={queryClient}><QueryClientProvider client={queryClient}>
        <UserSelect id="test-user" value="12" onValueChange={() => {}} />
      </QueryClientProvider></trpc.Provider>);
      assert.match(html, /Friend · VIP/);
      assert.match(html, /id="test-user"/);
      assert.match(html, /role="combobox"/);
      assert.match(html, /aria-expanded="false"/);
      assert.doesNotMatch(html, /disabled=""/);
      if (locale === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
      queryClient.clear();
    }
  } finally {
    setLanguagePreference(language);
    await initializeLanguage();
  }
});

test("all four user selection surfaces use the shared paginated selector instead of fetching every user", () => {
  for (const file of ["Operations", "Rules", "Billing", "Plans"]) {
    const source = readFileSync(`client/src/pages/${file}.tsx`, "utf8");
    assert.match(source, /<UserSelect\b/, file);
    assert.doesNotMatch(source, /trpc\.users\.options\.useQuery/, file);
  }
  const component = readFileSync("client/src/components/UserSelect.tsx", "utf8");
  assert.match(component, /limit: 20/);
  assert.match(component, /enabled: admin && open && !searching/);
  assert.doesNotMatch(component, /placeholderData:/, "never show stale results from another search");
  assert.match(component, /aria-activedescendant=/);
  assert.match(component, /optionsByIds\.setData\(\{ ids: \[option\.id\] \}, \[option\]\)/);
  assert.match(component, /user-select-content[^"\n]*bg-popover/);
  assert.doesNotMatch(component, /action-menu-content/, "user rows remain opaque on mobile without backdrop blur");
  assert.match(component, /event\.key === "ArrowDown"/);
  assert.match(component, /event\.key === "Enter"/);
});
