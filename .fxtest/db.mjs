// Read traffic totals straight from the test panel's SQLite database.
import Database from "better-sqlite3";
const db = new Database("/data/forwardx.db", { readonly: true, fileMustExist: true });
const q = process.argv[2] || "rules";
if (q === "rules") {
  const rows = db.prepare(`SELECT r.id, r.name, r.hostId, r.tunnelId, r.forwardGroupId,
      (SELECT COALESCE(SUM(bytesIn),0) FROM forward_rule_traffic_counters c WHERE c.ruleId=r.id) AS cin,
      (SELECT COALESCE(SUM(bytesOut),0) FROM forward_rule_traffic_counters c WHERE c.ruleId=r.id) AS cout,
      (SELECT COALESCE(SUM(bytesIn),0) FROM traffic_stats s WHERE s.ruleId=r.id) AS sin,
      (SELECT COALESCE(SUM(bytesOut),0) FROM traffic_stats s WHERE s.ruleId=r.id) AS sout,
      (SELECT GROUP_CONCAT(DISTINCT hostId) FROM forward_rule_traffic_counters c WHERE c.ruleId=r.id) AS hosts
    FROM forward_rules r ORDER BY r.id`).all();
  console.log(JSON.stringify(rows));
} else if (q === "users") {
  console.log(JSON.stringify(db.prepare(`SELECT u.id, u.trafficUsed, c.bytesIn, c.bytesOut FROM users u LEFT JOIN user_traffic_counters c ON c.userId=u.id`).all()));
} else if (q === "hosts") {
  console.log(JSON.stringify(db.prepare(`SELECT * FROM host_traffic_counters`).all()));
} else {
  console.log(JSON.stringify(db.prepare(q).all()));
}
