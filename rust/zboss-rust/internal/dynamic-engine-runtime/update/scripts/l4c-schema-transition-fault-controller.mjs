import {
  runScenarioFaultController,
  SCENARIO_FAULT_DEFINITIONS,
} from "./l4c-scenario-fault-controller.mjs";

const result = await runScenarioFaultController({
  definition: SCENARIO_FAULT_DEFINITIONS["schema-transition-failure"],
});
console.log(JSON.stringify(result));
