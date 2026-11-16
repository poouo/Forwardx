# snap.sh <tag> : wait until the panel's per-rule counters stop changing, then save them
cd /root/fxtest
prev=""; for i in $(seq 1 30); do
  cur="$(docker exec -w /app fxt-panel node /tmp/fxtest/db.mjs rules 2>/dev/null)"
  if [ -n "$prev" ] && [ "$cur" = "$prev" ]; then break; fi
  prev="$cur"; sleep 20
done
echo "$cur" > "snap-$1.json"; echo "snap-$1 saved after $i polls"
