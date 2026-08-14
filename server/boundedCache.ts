export function setBoundedMapValue<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number) {
  if (map.has(key)) map.delete(key);
  while (map.size >= Math.max(1, maxSize)) {
    const oldestKey = map.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
  map.set(key, value);
}

export function pruneMapEntries<K, V>(map: Map<K, V>, shouldDelete: (value: V, key: K) => boolean) {
  let deleted = 0;
  for (const [key, value] of map) {
    if (!shouldDelete(value, key)) continue;
    map.delete(key);
    deleted += 1;
  }
  return deleted;
}
