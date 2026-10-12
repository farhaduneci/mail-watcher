import { readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { generateRegistry } from "./scripts/registry";

export default defineConfig(async () => {
  generateRegistry();
  // Imported after the registry exists. The fixture is validated the same way the build does it.
  const { loadConfig } = await import("./src/config/load");
  const fixture = loadConfig(readFileSync("./test/fixtures/config.yaml", "utf8"), { crons: ["0 7 * * *", "0 8 * * MON"] });

  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./test/wrangler.test.jsonc" },
              // Tests stub the AI binding and fetch; never reach a real Cloudflare account.
              remoteBindings: false,
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: await readD1Migrations("./migrations"),
                  TEST_CONFIG: JSON.parse(JSON.stringify(fixture)),
                },
              },
            }),
          ],
          test: { name: "worker", include: ["test/worker/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
        },
        { test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" } },
      ],
    },
  };
});
