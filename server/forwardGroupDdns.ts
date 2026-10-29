import { forwardGroupDdnsRecordSets, normalizeForwardGroupRecordType } from "../shared/forwardGroupDdns";
import { updateDdnsRecordValues, type DdnsRecordValuesInput } from "./ddns";

export async function updateForwardGroupDdnsRecordValues(
  input: DdnsRecordValuesInput,
  update = updateDdnsRecordValues,
) {
  const errors: string[] = [];
  for (const record of forwardGroupDdnsRecordSets(normalizeForwardGroupRecordType(input.recordType), input.values)) {
    try {
      await update({ ...input, ...record });
    } catch (error) {
      // A failed provider request must not prevent the other family from
      // converging. The group's existing retry flow retries incomplete syncs.
      errors.push(`${record.recordType}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
}
