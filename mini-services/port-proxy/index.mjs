import { createServer } from "http";
import httpProxy from "http-proxy";

const LISTEN_PORT = Number(process.env.PORT || 5172);
const APP_PORT = Number(process.env.NEXT_INTERNAL_PORT || 5174);
const BUILD_PORT = Number(process.env.BUILD_SERVICE_PORT || 5173);
const BUILD_PATH = "/build-socket";

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

proxy.on("error", (_err, _req, res) => {
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway");
  }
});

function targetPort(url) {
  return url?.startsWith(BUILD_PATH) ? BUILD_PORT : APP_PORT;
}

const server = createServer((req, res) => {
  proxy.web(req, res, { target: `http://127.0.0.1:${targetPort(req.url)}` });
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${targetPort(req.url)}` });
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(
    `[dockgen] port-proxy listening on :${LISTEN_PORT} (app :${APP_PORT}, build :${BUILD_PORT})`,
  );
});
