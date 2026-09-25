// Cloudflare Worker entry. Static files in public/ are served by Workers Assets;
// only /api/* reaches this code (see wrangler.jsonc).
import { handleApi, type Env } from "./api";

export default {
  fetch: (req: Request, env: Env) => handleApi(req, env),
};
