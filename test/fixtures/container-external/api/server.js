import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4000);
createServer((request, response) => {
  response.statusCode = request.url === "/health" ? 200 : 404;
  response.end(request.url === "/health" ? "ok" : "not found");
}).listen(port, "0.0.0.0");
