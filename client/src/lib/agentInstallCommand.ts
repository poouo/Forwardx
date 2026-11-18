/** Keep appended installer arguments available to every download fallback. */
export function wrapAgentInstallPipelines(pipelines: string[]) {
  const body = `set -o pipefail; ${pipelines.map(pipeline => `${pipeline} "$@"`).join(" || ")}`;
  return `bash -c '${body.replace(/'/g, `'"'"'`)}' --`;
}
