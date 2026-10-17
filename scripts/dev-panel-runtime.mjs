export function devBackendArguments(entry = "server/index.ts") {
  return ["--watch", "--watch-preserve-output", "--import", "tsx", entry];
}

export function latestBackendPort(output) {
  const matches = [...output.matchAll(/ForwardX panel started on \S+ port (\d+)/g)];
  const port = Number(matches.at(-1)?.[1]);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

export function devBackendProxy(getPort) {
  let runtimeOptions;
  return {
    target: `http://127.0.0.1:${getPort()}`,
    configure(proxy) {
      runtimeOptions = proxy.options;
    },
    bypass(_req, _res, options) {
      // A watched backend may choose another free port after restarting.
      const target = `http://127.0.0.1:${getPort()}`;
      options.target = target;
      // Vite keeps a shallow copy for bypass; update http-proxy's options too.
      if (runtimeOptions) runtimeOptions.target = target;
    },
  };
}
