export type UserOption = {
  id: number;
  username: string;
  name?: string | null;
  email?: string | null;
  displayRemark?: string | null;
};

export function userOptionLabel(user: UserOption) {
  const name = user.name || user.username;
  return user.displayRemark ? `${name} · ${user.displayRemark}` : name;
}

export function userOptionDetail(user: UserOption) {
  return [user.name && user.name !== user.username ? user.username : null, user.email !== user.username ? user.email : null, `#${user.id}`].filter(Boolean).join(" · ");
}

// Bound metadata hydration to the selected owner and the visible rule page.
export function ruleOwnerOptionIds(rules: Array<{ userId?: number | null }>, selected?: number) {
  return [...new Set([selected, ...rules.map(rule => Number(rule.userId))]
    .filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0))].slice(0, 100).sort((a, b) => a - b);
}
