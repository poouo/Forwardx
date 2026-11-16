set -u
N="bash ./n.sh api.mjs"
docker update --restart unless-stopped fxt-panel >/dev/null; docker start fxt-panel >/dev/null; sleep 10
$N q setup.status | grep -E 'databaseConnected|schemaReady|hasAdmin|error'
$N m setup.createAdmin '{"email":"admin@fxtest.local","password":"FxTest-Stats-2026","name":"tester"}'
sleep 2
$N m auth.login '{"username":"admin@fxtest.local","password":"FxTest-Stats-2026"}' | head -8
$N q auth.me | head -8
docker logs --tail 6 fxt-panel 2>&1 | cut -c1-160
