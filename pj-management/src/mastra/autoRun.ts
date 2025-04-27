import { Agent } from '@mastra/core/agent';
import { anthropic } from '@ai-sdk/anthropic';
import { Workflow, Step } from '@mastra/core/workflows';
import { z } from 'zod';
import { mastra } from './index.js';

/*
  Planner / Executor implementation for generic Auto‑Run.
  The Planner decides the next operation; the Executor runs it in a loop
  until the Planner returns { action: "finish" }.
*/

export const plannerAgent = new Agent({
  name: 'plannerAgent',
  instructions: `
    You are a planner agent responsible for decomposing a GOAL into sequential operations.
    Available operations are any registered tool IDs or workflow IDs in the current Mastra runtime.

    Respond with valid JSON ONLY in the following schema:
    {
      "action": "run" | "finish",
      "toolId": string,  // required if action === "run"
      "params": object   // optional parameters matching that tool/workflow input
      "result": any      // required if action === "finish"
    }
  `,
  model: anthropic('claude-3-7-sonnet-20250219'),
  tools: {}, // Planner does not directly call tools
});

// Executor Step
const executor = new Step({
  id: 'executor',
  inputSchema: z.object({
    goal: z.string(),
    queue: z.array(z.any()).optional(),
  }),
  outputSchema: z.any(),
  execute: async ({ context }) => {
    const trigger = (context as any).triggerData ?? {};
    let queue = trigger.queue ?? [];
    const goal = trigger.goal;

    while (true) {
      const planRes = await plannerAgent.generate(JSON.stringify({ goal, queue }));

      let plan: { action: string; toolId?: string; params?: any; result?: any };
      try {
        plan = JSON.parse(planRes.text);
      } catch (err) {
        throw new Error(`Planner output is not valid JSON: ${planRes.text}`);
      }

      if (plan.action === 'finish') {
        return { result: plan.result, queue };
      }

      if (plan.action !== 'run' || !plan.toolId) {
        throw new Error(`Planner returned invalid action: ${JSON.stringify(plan)}`);
      }

      const { toolId, params } = plan;

      // Prefer tools, then workflows
      const tool: any = (mastra as any).tools?.[toolId];
      if (tool && typeof tool.execute === 'function') {
        const output = await tool.execute({ context: params });
        queue.push({ toolId, output });
        continue;
      }

      const wf = (mastra as any).workflows?.[toolId];
      if (wf) {
        const { start } = wf.createRun();
        const runRes = await start({ triggerData: params });
        queue.push({ workflowId: toolId, output: runRes });
        continue;
      }

      throw new Error(`Unknown tool or workflow: ${toolId}`);
    }
  },
});

export const autoRunWorkflow = new Workflow({
  name: 'auto-run',
  triggerSchema: z.object({ goal: z.string() }),
});

autoRunWorkflow.step(executor).commit();
