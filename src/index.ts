// The deployed entry point. `npm run build` writes generated/config.json from mailsentry.yaml.
import CONFIG from "../generated/config.json";
import type { Config } from "./config/schema";
import { createWorker } from "./worker";

export default createWorker(CONFIG as unknown as Config);
