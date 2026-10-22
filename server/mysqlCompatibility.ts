// mysql2's query-attributes execute flag is misread as a cursor request by
// older MySQL 8.0 servers (reproduced on 8.0.24; fixed upstream in 8.0.26).
// ForwardX does not use query attributes. Disable only this optional capability,
// retaining binary prepared statements and parameter binding on every client.
export const MYSQL_COMPATIBILITY_FLAGS = ["-CLIENT_QUERY_ATTRIBUTES"];
