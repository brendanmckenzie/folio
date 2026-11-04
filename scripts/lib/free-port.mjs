// Prints a TCP port nothing is listening on. Used by `scripts/e2e.sh`, which cannot
// assume 5199 is free: another dev server may hold it, and a parallel sweep needs
// one port per script. Binding port 0 and letting the OS choose is the only way to
// be sure the port is free at the moment of asking; the window between asking and
// the dev server binding is why the sweep hands out its own ports (`e2e-sweep.mjs`).
import { createServer } from "node:net";

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(await freePort());
