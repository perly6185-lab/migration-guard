import {
  runScenarioFaultController,
  SCENARIO_FAULT_DEFINITIONS,
} from "./l4c-scenario-fault-controller.mjs";

const scenarioId = process.argv[3] ?? process.env.MG_L4C_SCENARIO_ID;
const definition = SCENARIO_FAULT_DEFINITIONS[scenarioId];
if (!definition) throw new Error("fault controller scenario is not supported");
const result = await runScenarioFaultController({ definition });
console.log(JSON.stringify(result));
