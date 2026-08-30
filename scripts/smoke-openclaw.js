import { loadConfig } from "../src/config.js";
import { runOpenClawAgent } from "../src/openclaw.js";
import { checkpointAndCloseDatabase, getOperationalState, openDatabase, setOperationalState } from "../src/db.js";
import { AI_CIRCUIT_KEY } from "../src/ai-circuit.js";

const config = loadConfig();
const sessionPrefix = `smoke-test-${Date.now()}`;
for (const [stage, schema] of [["luna", "luna.v1"], ["terra", "terra.v1"], ["sol", "sol.v1"]]) {
  const result = await runOpenClawAgent(
    config,
    stage,
    `Return exactly this JSON object and no other text: {"schema_version":"${schema}","smoke_test":true}`,
    `${sessionPrefix}-${stage}`
  );
  if (result.output.schema_version !== schema || result.output.smoke_test !== true) {
    throw new Error(`Unexpected OpenClaw ${stage} smoke-test response.`);
  }
  console.log(JSON.stringify({ stage, ...result.output }));
}

// Only a complete Luna/Terra/Sol success proves that a switched account is
// usable. Clear a stale quota circuit after that proof so the listener can
// resume without waiting for the previous account's reset timestamp.
const db = openDatabase(config.data.database);
try {
  const prior = getOperationalState(db, AI_CIRCUIT_KEY);
  if (prior?.status === "open") {
    const now = new Date().toISOString();
    setOperationalState(db, AI_CIRCUIT_KEY, {
      ...prior,
      status: "closed",
      recovered_at: now,
      updated_at: now,
      recovery_reason: "all_openclaw_agents_verified"
    });
    console.log(JSON.stringify({ ai_circuit: "closed_after_verified_account_switch" }));
  }
} finally {
  checkpointAndCloseDatabase(db);
}
