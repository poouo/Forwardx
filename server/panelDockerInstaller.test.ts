import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-panel-docker.sh"), "utf8");

function section(start: string, end: string) {
  const startIndex = script.indexOf(start);
  const endIndex = script.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return script.slice(startIndex, endIndex);
}

test("Docker uninstall resolves the data volume from the live container before removing it", () => {
  const volumeResolver = section("panel_data_volume_names() {", "uninstall_data_volume_names() {");
  const uninstall = section("uninstall_panel() {", "case \"$ACTION\" in");

  assert.match(volumeResolver, /docker inspect --format .*\.Destination "\/data"/);
  assert.match(volumeResolver, /\.Type "volume"/);
  assert.ok(uninstall.indexOf('volume_names="$(uninstall_data_volume_names)"') < uninstall.indexOf("down --remove-orphans"));
  assert.ok(uninstall.indexOf('persist_uninstall_data_volume_names "$volume_names"') < uninstall.indexOf("down --remove-orphans"));
  assert.ok(uninstall.indexOf('volume_names="$(uninstall_data_volume_names)"') < uninstall.indexOf("remove_existing_panel_containers"));
});

test("Docker uninstall remembers a non-default data volume across retries", () => {
  const resolver = section("uninstall_volume_state_file() {", "ensure_data_volume() {");

  assert.match(resolver, /\.forwardx-uninstall-volumes/);
  assert.match(resolver, /awk 'NF' "\$state_file"/);
  assert.match(resolver, /umask 077/);
  assert.match(resolver, /printf "%s\\n" "\$volume_names" > "\$state_file"/);
});

test("Docker uninstall reports persistent volume removal failures instead of claiming success", () => {
  const uninstall = section("uninstall_panel() {", "case \"$ACTION\" in");

  assert.match(uninstall, /Failed to remove Docker data volume/);
  assert.match(uninstall, /volume_remove_failed="true"/);
  assert.match(uninstall, /return 1/);
  assert.match(uninstall, /External MySQL\/PostgreSQL database contents.*were not deleted/);
  assert.doesNotMatch(uninstall, /docker volume rm .*\|\| true/);
});

test("Docker install warns when existing administrator data will be reused", () => {
  const ensureVolume = section("ensure_data_volume() {", "load_existing_env() {");
  const readDatabaseConfig = section("read_database_config_json() {", "write_database_config_to_volume() {");

  assert.match(ensureVolume, /Existing Docker data volume will be reused/);
  assert.match(ensureVolume, /administrator credentials are retained/);
  assert.match(readDatabaseConfig, /docker volume inspect .*data_volume_name/);
  assert.match(readDatabaseConfig, /preserving its database configuration and administrator data/);
  assert.ok(readDatabaseConfig.indexOf("preserving its database configuration") < readDatabaseConfig.indexOf("Select database type"));
});

test("Docker uninstall retains deployment metadata until every data volume is removed", () => {
  const uninstall = section("uninstall_panel() {", "case \"$ACTION\" in");

  assert.ok(uninstall.indexOf('if [ "$volume_remove_failed" = "true" ]') < uninstall.indexOf('rm -rf "$APP_DIR"'));
  assert.match(uninstall, /Deployment metadata is retained/);
});

test("the environment example does not advertise the removed ADMIN_PASSWORD behavior", () => {
  const envExample = fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8");

  assert.doesNotMatch(envExample, /^ADMIN_PASSWORD=/m);
  assert.match(envExample, /不支持通过 ADMIN_PASSWORD 重置管理员密码/);
});
