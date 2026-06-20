import type { Session } from "./dom-host.js";
import type { Scenario } from "./scenario.js";
import type { Rng } from "./prng.js";
import { mousePath, clickPlacement } from "./realism.js";

// Execute a scenario against a live Session, applying realism (decimated cursor paths, gaussian click
// placement) and advancing time via session.advance (virtual in deterministic mode, real otherwise),
// so timing is reproducible. The caller owns session.end()/close().
export async function runScenario(session: Session, scenario: Scenario, rng: Rng): Promise<void> {
  let pos = { x: 0, y: 0 };
  const moveStream = rng.substream(1);
  const clickStream = rng.substream(2);
  const waitStream = rng.substream(3);

  const playPath = async (target: { x: number; y: number }): Promise<void> => {
    for (const p of mousePath(pos, target, moveStream)) {
      session.moveTo(p.x, p.y);
      await session.advance(p.dt);
    }
    pos = target;
  };

  for (const step of scenario.steps) {
    switch (step.type) {
      case "wait":
        await session.advance(step.ms);
        break;
      case "scrollTo":
        session.scrollTo(step.y);
        await session.advance(Math.round(waitStream.logNormal(120, 0.3)));
        break;
      case "move":
        await playPath(clickPlacement(session.locate(step.selector), moveStream));
        break;
      case "click":
        await playPath(clickPlacement(session.locate(step.selector), clickStream));
        session.click(step.selector);
        await session.advance(Math.round(waitStream.logNormal(300, 0.3)));
        break;
      case "type":
        session.type(step.selector, step.text);
        await session.advance(Math.round(waitStream.logNormal(200, 0.3)));
        break;
      default: {
        const _exhaustive: never = step;
        void _exhaustive;
      }
    }
  }
}
