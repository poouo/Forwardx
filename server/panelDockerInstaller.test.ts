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

function assertBefore(source: string, before: string, after: string) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  assert.notEqual(beforeIndex, -1, `missing ordered text: ${before}`);
  assert.notEqual(afterIndex, -1, `missing ordered text: ${after}`);
  assert.ok(beforeIndex < afterIndex, `expected ${before} before ${after}`);
}

test("Docker uninstall resolves the data volume from the live container before removing it", () => {
  const volumeResolver = section("panel_data_volume_names() {", "uninstall_data_volume_names() {");
  const uninstall = section("uninstall_panel() {", "case \"$ACTION\" in");

  assert.match(volumeResolver, /docker inspect --format .*\.Destination "\/data"/);
  assert.match(volumeResolver, /\.Type "volume"/);
  assertBefore(uninstall, 'volume_names="$(uninstall_data_volume_names)"', "down --remove-orphans");
  assertBefore(uninstall, 'persist_uninstall_data_volume_names "$volume_names"', "down --remove-orphans");
  assertBefore(uninstall, 'volume_names="$(uninstall_data_volume_names)"', "remove_existing_panel_containers");
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
  assertBefore(readDatabaseConfig, "preserving its database configuration", "Select database type");
});

test("Docker uninstall retains deployment metadata until every data volume is removed", () => {
  const uninstall = section("uninstall_panel() {", "case \"$ACTION\" in");

  assertBefore(uninstall, 'if [ "$volume_remove_failed" = "true" ]', 'rm -rf "$APP_DIR"');
  assert.match(uninstall, /Deployment metadata is retained/);
});

test("Docker install and upgrade carry the resolved release version into verification", () => {
  const resolver = section("resolve_image_selection() {", "install_base_deps() {");
  const install = section("install_panel() {", "upgrade_panel() {");
  const upgrade = section("upgrade_panel() {", "uninstall_panel() {");

  assert.match(resolver, /EXPECTED_PANEL_VERSION="\$version"/);
  assert.match(resolver, /RESOLVED_IMAGE="\$\{IMAGE_REPO\}:v\$\{version\}"/);
  assertBefore(install, "resolve_image_selection", 'image="$RESOLVED_IMAGE"');
  assert.match(install, /start_panel "\$image" "\$EXPECTED_PANEL_VERSION"/);
  assertBefore(upgrade, "resolve_image_selection", 'image="$RESOLVED_IMAGE"');
  assert.match(upgrade, /start_panel "\$image" "\$EXPECTED_PANEL_VERSION"/);
});

test("Docker upgrade verifies both image metadata version sources before replacing the old container", () => {
  const verification = section("image_panel_version() {", "image_repository_from_ref() {");
  const start = section("start_panel() {", "install_panel() {");

  assert.match(verification, /require\('\.\/package\.json'\)\.version/);
  assert.match(verification, /org\.opencontainers\.image\.version/);
  assert.match(verification, /package_version.*!=.*expected/);
  assert.match(verification, /unknown\|"<no value>"\|null/);
  assert.match(verification, /label conflicts with its expected version/);
  assert.match(verification, /Registry Mirrors/);
  assertBefore(start, 'assert_target_image_ready "$image" "$expected_version"', "remove_existing_panel_containers");
});

test("Docker upgrade verifies the recreated container image ID and embedded version", () => {
  const verification = section("running_panel_version() {", "image_repository_from_ref() {");
  const start = section("start_panel() {", "install_panel() {");

  assert.match(verification, /docker exec "\$CONTAINER_NAME" node/);
  assert.match(verification, /\.State\.Running/);
  assert.match(verification, /\.Image/);
  assert.match(verification, /Unable to read the ForwardX version from the running container/);
  assert.match(verification, /active_image_id.*!=.*expected_image_id/);
  assert.match(verification, /running_version.*!=.*expected_version/);
  assertBefore(start, 'pulled_image_id="$(image_id "$image"', "remove_existing_panel_containers");
  assertBefore(start, "compose_cmd", 'assert_running_panel_ready "$pulled_image_id" "$expected_version"');
  assertBefore(start, "assert_running_panel_ready", "cleanup_old_panel_images");
});

test("Docker container replacement logs an explicit removal message", () => {
  const removal = section("remove_existing_panel_containers() {", "image_panel_version() {");

  assert.match(removal, /docker rm -f "\$id" >\/dev\/null 2>&1/);
  assert.match(removal, /Removed previous ForwardX container/);
});

test("the environment example does not advertise the removed ADMIN_PASSWORD behavior", () => {
  const envExample = fs.readFileSync(path.join(process.cwd(), ".env.example"), "utf8");

  assert.doesNotMatch(envExample, /^ADMIN_PASSWORD=/m);
  assert.match(envExample, /不支持通过 ADMIN_PASSWORD 重置管理员密码/);
});
