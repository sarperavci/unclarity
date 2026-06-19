import type { Session } from "./dom-host.js";
import type { Scenario } from "./scenario.js";
import type { Rng } from "./prng.js";
import { mousePath, clickPlacement } from "./realism.js";
import { sleep } from "./util.js";

// Execute a scenario against a live Session, applying realism (decimated cursor paths, gaussian click
// placement). The caller owns session.end()/close().
export async function runScenario(session: Session, scenario: Scenario, rng: Rng): Promise<void> {
  let pos = { x: 0, y: 0 };
  const moveStream = rng.substream(1);
  const clickStream = rng.substream(2);
  const waitStream = rng.substream(3);

  for (const step of scenario.steps) {
    switch (step.type) {
      case "wait":
        await sleep(Math.min(step.ms, Math.round(waitStream.logNormal(Math.max(step.ms, 1), 0.2))));
        break;
      case "scrollTo":
        session.scrollTo(step.y);
        break;
      case "move": {
        const box = session.locate(step.selector);
        const target = clickPlacement(box, moveStream);
        for (const p of mousePath(pos, target, moveStream)) session.moveTo(p.x, p.y);
        pos = target;
        break;
      }
      case "click": {
        const box = session.locate(step.selector);
        const target = clickPlacement(box, clickStream);
        for (const p of mousePath(pos, target, moveStream)) session.moveTo(p.x, p.y);
        pos = target;
        session.click(step.selector);
        break;
      }
      case "type":
        session.type(step.selector, step.text);
        break;
      default: {
        const _exhaustive: never = step;
        void _exhaustive;
      }
    }
  }
}
