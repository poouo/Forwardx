cd /root/fxtest
docker cp -q hosts.json fxt-panel:/tmp/fxtest/hosts.json 2>/dev/null
bash ./n.sh s3.mjs | tail -2
docker cp -q fxt-panel:/tmp/fxtest/hosts.json . ; cat hosts.json; echo
bash ./n.sh s4.mjs
docker cp -q fxt-panel:/tmp/fxtest/made.json .
