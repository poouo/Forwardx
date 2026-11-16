set -u
cd /root/fxtest
docker cp -q db.mjs fxt-panel:/tmp/fxtest/db.mjs
bash ./n.sh s4.mjs | grep -v '^\[\['
docker cp -q fxt-panel:/tmp/fxtest/made.json .
echo "waiting for agents to deploy"; sleep 45
bash snap.sh base
bash run.sh tcp tcp
bash snap.sh tcp
bash run.sh udp udp
bash snap.sh udp
echo S5_DONE
