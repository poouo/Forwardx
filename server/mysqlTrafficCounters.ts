type Cell = number | string;
type CounterBatch = {
  table: string;
  columns: string[];
  keys: string[];
  rows: Cell[][];
  add: string[];
  replace: string[];
};

type CounterDatabase = {
  query: (sql: string, params: Cell[]) => Promise<Array<Record<string, Cell>>>;
  execute: (sql: string, params: Cell[]) => Promise<unknown>;
};

/** Existing auto-increment counters must not repeatedly take the INSERT path.
 * Call within the accounting transaction and its user locks. New rows retain
 * the atomic duplicate-key fallback. All identifiers are internal constants.
 */
export async function writeMysqlTrafficCounters(batch: CounterBatch, database: CounterDatabase) {
  const q = (name: string) => `\`${name}\``;
  const index = (name: string) => batch.columns.indexOf(name);
  const keyIndexes = batch.keys.map(index);
  const keyOf = (row: Cell[]) => JSON.stringify(keyIndexes.map(i => String(row[i])));
  const sorted = [...batch.rows].sort((a, b) => {
    for (const i of keyIndexes) if (a[i] !== b[i]) {
      if (typeof a[i] === "number" && typeof b[i] === "number") return Number(a[i]) - Number(b[i]);
      return String(a[i]) < String(b[i]) ? -1 : 1;
    }
    return 0;
  });
  for (let offset = 0; offset < sorted.length; offset += 64) {
    const rows = sorted.slice(offset, offset + 64);
    const tuple = `(${batch.keys.map(q).join(",")})`;
    const values = rows.map(() => `(${batch.keys.map(() => "?").join(",")})`).join(",");
    const existing = await database.query(
      `SELECT ${["id", ...batch.keys].map(q).join(",")} FROM ${q(batch.table)} WHERE ${tuple} IN (${values})`,
      rows.flatMap(row => keyIndexes.map(i => row[i])),
    );
    const ids = new Map(existing.map(row => [JSON.stringify(batch.keys.map(key => String(row[key]))), Number(row.id)]));
    const updates = rows.filter(row => ids.has(keyOf(row))).sort((a, b) => ids.get(keyOf(a))! - ids.get(keyOf(b))!);
    if (updates.length) {
      const params: Cell[] = [];
      const assignments = [...batch.add, ...batch.replace].map(column => {
        const cases = updates.map(row => {
          params.push(ids.get(keyOf(row))!, row[index(column)]);
          return "WHEN ? THEN ?";
        }).join(" ");
        return `${q(column)} = ${batch.add.includes(column) ? `${q(column)} + ` : ""}CASE ${q("id")} ${cases} ELSE ${batch.add.includes(column) ? "0" : q(column)} END`;
      });
      params.push(...updates.map(row => ids.get(keyOf(row))!));
      await database.execute(`UPDATE ${q(batch.table)} SET ${assignments.join(",")} WHERE ${q("id")} IN (${updates.map(() => "?").join(",")})`, params);
    }
    const inserts = rows.filter(row => !ids.has(keyOf(row)));
    if (inserts.length) {
      const suffix = [...batch.add, ...batch.replace].map(column =>
        `${q(column)} = ${batch.add.includes(column) ? `${q(column)} + ` : ""}VALUES(${q(column)})`).join(",");
      await database.execute(`INSERT INTO ${q(batch.table)} (${batch.columns.map(q).join(",")}) VALUES ${inserts.map(() => `(${batch.columns.map(() => "?").join(",")})`).join(",")} ON DUPLICATE KEY UPDATE ${suffix}`, inserts.flat());
    }
  }
}
