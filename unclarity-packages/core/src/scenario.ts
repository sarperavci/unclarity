// Declarative, serializable scenario (the wire form shared with the Python client) + a fluent builder.
export type Step =
  | { type: "wait"; ms: number }
  | { type: "move"; selector: string }
  | { type: "click"; selector: string }
  | { type: "scrollTo"; y: number }
  | { type: "type"; selector: string; text: string };

export interface Scenario {
  steps: Step[];
}

export class ScenarioBuilder {
  private readonly steps: Step[] = [];
  wait(ms: number): this {
    this.steps.push({ type: "wait", ms });
    return this;
  }
  move(selector: string): this {
    this.steps.push({ type: "move", selector });
    return this;
  }
  click(selector: string): this {
    this.steps.push({ type: "click", selector });
    return this;
  }
  scrollTo(y: number): this {
    this.steps.push({ type: "scrollTo", y });
    return this;
  }
  type(selector: string, text: string): this {
    this.steps.push({ type: "type", selector, text });
    return this;
  }
  build(): Scenario {
    return { steps: [...this.steps] };
  }
  toJSON(): Scenario {
    return this.build();
  }
}

export function scenario(): ScenarioBuilder {
  return new ScenarioBuilder();
}
