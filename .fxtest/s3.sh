set -u
cd /root/fxtest
for c in fxt-target fxt-client; do docker cp -q sink.py $c:/root/sink.py; docker cp -q gen.py $c:/root/gen.py; done
docker exec fxt-target pkill -f sink.py >/dev/null 2>&1; docker exec -d fxt-target python3 /root/sink.py 9000
sleep 1
echo "direct baseline:"; docker exec fxt-client python3 /root/gen.py tcp 172.30.0.20 9000 10000000 20000000
docker exec fxt-client python3 /root/gen.py udp 172.30.0.20 9000 2000 1000 4000
bash ./n.sh s3.mjs
docker cp -q hosts.json fxt-panel:/tmp/fxtest/ 2>/dev/null; docker cp -q fxt-panel:/tmp/fxtest/hosts.json . 2>/dev/null; cat hosts.json; echo
