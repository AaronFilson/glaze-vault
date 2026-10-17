// Choosing materials for a fit (fit.ts, chooseLines), in a worker where there is one, so the page
// stays responsive, and on the page's thread where there is not, as in tests.
import { selectMaterials, type Selection } from '@glazecalc/chemistry';
import type { ChooseJob } from './fit';

export function select(job: ChooseJob): Promise<Selection> {
  const { lines, target, options } = job;
  const here = () => selectMaterials(lines, target, options);
  if (typeof Worker === 'undefined') return new Promise((resolve) => resolve(here()));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./chooseWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(here());
      return;
    }
    worker.onmessage = (event: MessageEvent<{ selection: Selection } | { problem: string }>) => {
      worker.terminate();
      if ('problem' in event.data) reject(new Error(event.data.problem));
      else resolve(event.data.selection);
    };
    // A worker that cannot start, as under a policy that refuses it, leaves it to the page.
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      try {
        resolve(here());
      } catch (e) {
        reject(e);
      }
    };
    worker.postMessage({ lines, target, options });
  });
}
