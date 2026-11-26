// What the end-to-end tests do, in order, in one vault: each scenario starts where the one before
// left off. Commands are ui/devDriver.ts's; `expect` fails a script when the text does not show.
import { bodiesFiringsAndToolsScenarios } from './scenarios/bodiesFiringsAndTools.ts';
import { newRecoveryKey, quote, recipeLines, type Scenario, type Vault } from './scenarios/helpers.ts';
import { importExportAndSecurityScenarios } from './scenarios/importExportAndSecurity.ts';
import { teamAndBatchesScenarios } from './scenarios/teamAndBatches.ts';
import { vaultAndRecipesScenarios } from './scenarios/vaultAndRecipes.ts';

export { newRecoveryKey, quote, recipeLines, type Scenario, type Vault };

export const scenarios: Scenario[] = [
  ...vaultAndRecipesScenarios,
  ...importExportAndSecurityScenarios,
  ...teamAndBatchesScenarios,
  ...bodiesFiringsAndToolsScenarios
];
