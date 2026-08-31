// This entry is bundled with every runtime dependency for VPS enrollment. The
// regular npm CLI remains modular; the server installer never resolves npm
// dependencies after verifying the uploaded tarball checksum. Mark the process
// as a server runtime before any command runs so the optional AI advisor cannot
// be invoked from the privileged bundle.
import { runServerCli } from "./server-cli.js";

process.env.DEPLOYKIT_SERVER_RUNTIME = "1";

void runServerCli().then((exitCode) => {
  process.exitCode = exitCode;
});
