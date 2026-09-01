import { createServer } from "node:http";

const port = Number(process.env.PORT);
createServer((request, response) => {
  response.statusCode = request.url === "/health" ? 200 : 200;
  response.end(request.url === "/health" ? "ok" : "fixture SSR response");
}).listen(port, "127.0.0.1");
