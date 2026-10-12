import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BUILTIN_AVATARS, builtinAvatarPath, builtinAvatarValue, migrateLegacyAvatarValue } from "@shared/avatar";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { avatarSrc } from "@/lib/avatar";
import { AvatarPicker } from "./AvatarPicker";

test("picker shows all twenty local avatars, with bilingual accessible selection", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      const value = builtinAvatarValue("panda");
      const html = renderToStaticMarkup(<AvatarPicker value={value} onChange={() => {}} />);
      assert.equal((html.match(/aria-pressed=/g) || []).length, 20);
      assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
      assert.equal((html.match(/<img /g) || []).length, 20);
      for (const avatar of BUILTIN_AVATARS) {
        assert.ok(html.includes(builtinAvatarPath(builtinAvatarValue(avatar.id))));
        assert.ok(html.includes(`aria-label="${language === "en" ? avatar.nameEn : avatar.name}"`));
      }
      assert.match(html, /type="file"[^>]*accept="image\/png,image\/jpeg,image\/webp,image\/gif"/);
      assert.match(html, /grid-cols-5/);
      if (language === "en") {
        assert.doesNotMatch(html, /\p{Script=Han}/u);
        assert.match(html, /Upload/);
        assert.match(html, /Random/);
      }
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("uploaded images survive editing and legacy avatars resolve to local assets", () => {
  const uploaded = "data:image/png;base64,YQ==";
  assert.equal(avatarSrc(uploaded), uploaded);
  const html = renderToStaticMarkup(<AvatarPicker value={uploaded} onChange={() => {}} disabled />);
  assert.doesNotMatch(html, /aria-pressed="true"/);
  assert.equal((html.match(/aria-pressed=/g) || []).length, 20);
  for (const value of ["", "avataaars:legacy", "multiavatar:legacy", "preset:legacy"]) {
    assert.equal(avatarSrc(value, 12), builtinAvatarPath(migrateLegacyAvatarValue(value, 12)));
  }
});
