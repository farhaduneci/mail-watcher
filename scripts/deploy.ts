// Ships a config change in one command: validate + bundle → migrate → deploy.
import { errorText } from "../src/errors";
import { cli } from "./cli";
import { MIGRATE } from "./paths";

export interface DeployTools {
  build(): Promise<unknown>;
  wrangler(args: string[]): Promise<unknown>;
}

export async function deploy(tools: DeployTools): Promise<void> {
  await tools.build();
  await tools.wrangler(MIGRATE);
  await tools.wrangler(["deploy"]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { build, wrangler } = cli();
  await deploy({ build, wrangler }).catch((e) => {
    console.error(errorText(e, 2000));
    process.exit(1);
  });
}
