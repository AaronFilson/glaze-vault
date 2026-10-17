// Runs Glazecalc's selectMaterials off the page's thread: choosing among the whole library takes a
// few seconds (fit.ts, chooseLines).
import { selectMaterials } from '@glazecalc/chemistry';
import type { ChooseJob } from './fit';

self.onmessage = (event: MessageEvent<Omit<ChooseJob, 'prepared'>>) => {
  const { lines, target, options } = event.data;
  try {
    self.postMessage({ selection: selectMaterials(lines, target, options) });
  } catch (e) {
    self.postMessage({ problem: (e as Error).message });
  }
};
