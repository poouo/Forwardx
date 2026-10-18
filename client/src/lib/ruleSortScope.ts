type RuleSortCategory = "all" | "local" | "tunnel" | "chain" | "group";

/** A type-only filter still shows the whole category; a resource ID does not. */
export function isCompleteRuleSortScope(category: RuleSortCategory, resource: string): boolean {
  // Page offsets are category-wide, so sorting a mixed or partial scope is unsafe.
  return category !== "all" && (resource === "all" || resource === category);
}
