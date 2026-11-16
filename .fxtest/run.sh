# run.sh tcp|udp <tag> : push traffic through every rule from the client, record what was really sent
set -u
cd /root/fxtest
MODE="$1"; TAG="$2"; ENTRY=172.30.0.11
jq -r '.rules[] | "\(.name) \(.port)"' made.json > /tmp/fxt-rules.txt
out="actual-$TAG.jsonl"; : > "$out"
while read -r name port; do
  if [ "$MODE" = tcp ]; then
    r="$(timeout 150 docker exec fxt-client python3 /root/gen.py tcp $ENTRY "$port" ${UP:-20000000} ${DOWN:-40000000} ${CONNS:-1} 2>&1 | tail -1)"
  else
    r="$(timeout 150 docker exec fxt-client python3 /root/gen.py udp $ENTRY "$port" ${PKTS:-1500} ${SIZE:-1000} ${PPS:-3000} 2>&1 | tail -1)"
  fi
  case "$r" in \{*) ;; *) r="{\"error\":$(printf '%s' "$r" | head -c 200 | jq -Rs .)}";; esac
  echo "{\"name\":\"$name\",\"port\":$port,\"r\":$r}" >> "$out"
  echo "$name $port $r"
done < /tmp/fxt-rules.txt
echo RUN_DONE
