// Root entry point for the hosting platform.
//
// The platform expects package.json "main"/"start" to reference a top-level
// entry file (e.g. server.js). The actual server implementation lives in
// server/index.js; importing it here runs it (it calls server.listen on
// process.env.PORT, binding 0.0.0.0). Keeping this thin shim at the repo root
// satisfies the entry-point requirement without moving the codebase.
import './server/index.js';
