// Ships a config change in one command: validate + bundle → migrate → deploy.
import { cli } from "./cli";

export interface DeployTools {
  build(): Promise<unknown>;
  wrangler(args: string[]): Promise<unknown>;
}

export async function deploy(tools: DeployTools): Promise<void> {
  await tools.build();
  await tools.wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
  await tools.wrangler(["deploy"]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { build, wrangler } = cli();
  await deploy({ build, wrangler }).catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
