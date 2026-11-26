// Runs Glazecalc's selectMaterials off the page's thread: choosing among the whole library takes a
// few seconds (fit.ts, chooseLines).
import { selectMaterials } from '@glazecalc/core/chemistry';
import { HOST, inWords } from './chemistryHost';
import type { ChooseJob } from './fit';

self.onmessage = (event: MessageEvent<Omit<ChooseJob, 'prepared'>>) => {
  const { lines, target, options } = event.data;
  try {
    self.postMessage({ selection: inWords(selectMaterials)(HOST, lines, target, options) });
  } catch (e) {
    self.postMessage({ problem: (e as Error).message });
  }
};
