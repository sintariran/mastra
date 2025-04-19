import fs from 'fs';
import path from 'path';
import { openai } from '@ai-sdk/openai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Agent } from '../agent';
import { Container } from '../di';
import { createLogger } from '../logger';
import { Mastra } from '../mastra';
import { TABLE_WORKFLOW_SNAPSHOT } from '../storage';
import { DefaultStorage } from '../storage/libsql';
import { Telemetry } from '../telemetry';
import { createTool } from '../tools';

import { Step } from './step';
import type { WorkflowContext, WorkflowResumeResult } from './types';
import { WhenConditionReturnValue } from './types';
import { Workflow } from './workflow';

const storage = new DefaultStorage({
  config: {
    url: 'file::memory:?cache=shared',
  },
});

const logger = createLogger({
  level: 'info',
});

describe('Workflow', async () => {
  beforeEach(async () => {
    await storage.init();
  });

  describe('Basic Workflow Execution', () => {
    it('should execute a single step workflow successfully', async () => {
      const execute = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const step1 = new Step({ id: 'step1', execute });

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow.step(step1).commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(execute).toHaveBeenCalled();
      expect(result.results['step1']).toEqual({
        status: 'success',
        output: { result: 'success' },
      });
    });

    it('should execute multiple steps in parallel', async () => {
      const step1Action = vi.fn().mockImplementation(async () => {
        return { value: 'step1' };
      });
      const step2Action = vi.fn().mockImplementation(async () => {
        return { value: 'step2' };
      });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow.step(step1).step(step2).commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).toHaveBeenCalled();
      expect(result.results).toEqual({
        step1: { status: 'success', output: { value: 'step1' } },
        step2: { status: 'success', output: { value: 'step2' } },
      });
    });

    it('should execute steps sequentially', async () => {
      const executionOrder: string[] = [];

      const step1Action = vi.fn().mockImplementation(() => {
        executionOrder.push('step1');
        return { value: 'step1' };
      });
      const step2Action = vi.fn().mockImplementation(() => {
        executionOrder.push('step2');
        return { value: 'step2' };
      });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow.step(step1).then(step2).commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(executionOrder).toEqual(['step1', 'step2']);
      expect(result.results).toEqual({
        step1: { status: 'success', output: { value: 'step1' } },
        step2: { status: 'success', output: { value: 'step2' } },
      });
    });
  });

  describe('Simple Conditions', () => {
    it('should follow conditional chains', async () => {
      const step1Action = vi.fn().mockImplementation(() => {
        return Promise.resolve({ status: 'success' });
      });
      const step2Action = vi.fn().mockImplementation(() => {
        return Promise.resolve({ result: 'step2' });
      });
      const step3Action = vi.fn().mockImplementation(() => {
        return Promise.resolve({ result: 'step3' });
      });

      const step1 = new Step({
        id: 'step1',
        execute: step1Action,
        outputSchema: z.object({ status: z.string() }),
      });
      const step2 = new Step({
        id: 'step2',
        execute: step2Action,
      });
      const step3 = new Step({ id: 'step3', execute: step3Action });

      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema: z.object({
          status: z.enum(['pending', 'success', 'failed']),
        }),
      });

      workflow
        .step(step1, {
          id: 'step1',
          variables: {
            status: { step: 'trigger', path: 'status' },
          },
        })
        .then(step2, {
          id: 'step2',
          when: {
            ref: { step: step1, path: 'status' },
            query: { $eq: 'success' },
          },
        })
        .then(step3, {
          id: 'step3',
          when: {
            ref: { step: step1, path: 'status' },
            query: { $eq: 'failed' },
          },
        })
        .commit();

      const run = workflow.createRun();
      const result = await run.start({ triggerData: { status: 'pending' } });

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).toHaveBeenCalled();
      expect(step3Action).not.toHaveBeenCalled();
      expect(result.results).toEqual({
        step1: { status: 'success', output: { status: 'success' } },
        step2: { status: 'success', output: { result: 'step2' } },
        step3: { status: 'failed', error: 'Step:step3 condition check failed' },
      });
    });

    it('should handle failing dependencies', async () => {
      const step1Action = vi.fn<any>().mockRejectedValue(new Error('Failed'));
      const step2Action = vi.fn<any>();

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow.step(step1).then(step2).commit();

      const run = workflow.createRun();
      let result: Awaited<ReturnType<typeof run.start>> | undefined = undefined;
      try {
        result = await run.start();
      } catch {
        // do nothing
      }

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).not.toHaveBeenCalled();
      expect(result?.results).toEqual({
        step1: { status: 'failed', error: 'Failed' },
      });
    });

    it('should support simple string conditions', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ status: 'success' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'step2' });
      const step3Action = vi.fn<any>().mockResolvedValue({ result: 'step3' });
      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });
      const step3 = new Step({ id: 'step3', execute: step3Action });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow
        .step(step1)
        .then(step2, {
          id: 'step2',
          when: {
            'step1.status': 'success',
          },
        })
        .then(step3, {
          id: 'step3',
          when: {
            'step2.status': 'unexpected value',
          },
        })
        .commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).toHaveBeenCalled();
      expect(step3Action).not.toHaveBeenCalled();
      expect(result.results).toEqual({
        step1: { status: 'success', output: { status: 'success' } },
        step2: { status: 'success', output: { result: 'step2' } },
        step3: { status: 'failed', error: 'Step:step3 condition check failed' },
      });
    });

    it('should support custom condition functions', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ count: 5 });
      const step2Action = vi.fn<any>();

      const step1 = new Step({
        id: 'step1',
        execute: step1Action,
        outputSchema: z.object({ count: z.number() }),
      });
      const step2 = new Step({ id: 'step2', execute: step2Action });

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow
        .step(step1)
        .then(step2, {
          id: 'step2',
          when: async ({ context }) => {
            const step1Result = context.getStepResult(step1);

            return step1Result ? step1Result.count > 3 : false;
          },
        })
        .commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step2Action).toHaveBeenCalled();
      expect(result.results.step1).toEqual({
        status: 'success',
        output: { count: 5 },
      });
      expect(result.results.step2).toEqual({
        status: 'success',
        output: undefined,
      });
    });
  });

  describe('Variable Resolution', () => {
    it('should resolve trigger data', async () => {
      const execute = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const triggerSchema = z.object({
        inputData: z.string(),
      });

      const step1 = new Step({ id: 'step1', execute });
      const step2 = new Step({ id: 'step2', execute });

      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema,
      });

      workflow
        .step(step1, {
          id: 'step1',
          variables: {
            inputData: { step: 'trigger', path: 'inputData' },
          },
        })
        .then(step2)
        .commit();

      const run = workflow.createRun();
      const result = await run.start({ triggerData: { inputData: 'test-input' } });

      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success' } });
      expect(result.results.step2).toEqual({ status: 'success', output: { result: 'success' } });
    });

    it('should provide access to step results and trigger data via getStepResult helper', async () => {
      type TestTriggerSchema = z.ZodObject<{ inputValue: z.ZodString }>;

      const step1Action = vi
        .fn()
        .mockImplementation(async ({ context }: { context: WorkflowContext<TestTriggerSchema> }) => {
          // Test accessing trigger data with correct type
          const triggerData = context?.getStepResult<{ inputValue: string }>('trigger');
          expect(triggerData).toEqual({ inputValue: 'test-input' });
          return { value: 'step1-result' };
        });

      const step2Action = vi
        .fn()
        .mockImplementation(async ({ context }: { context: WorkflowContext<TestTriggerSchema> }) => {
          // Test accessing previous step result with type
          type Step1Result = { value: string };
          const step1Result = context?.getStepResult<Step1Result>('step1');
          expect(step1Result).toEqual({ value: 'step1-result' });

          // Verify that failed steps return undefined
          // @ts-ignore
          const failedStep = context?.getStepResult<never>('non-existent-step');
          expect(failedStep).toBeUndefined();

          return { value: 'step2-result' };
        });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });

      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema: z.object({
          inputValue: z.string(),
        }),
      });

      workflow.step(step1).then(step2).commit();

      const run = workflow.createRun();
      const result = await run.start({ triggerData: { inputValue: 'test-input' } });

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).toHaveBeenCalled();
      expect(result.results).toEqual({
        step1: { status: 'success', output: { value: 'step1-result' } },
        step2: { status: 'success', output: { value: 'step2-result' } },
      });
    });

    it('should resolve trigger data from context', async () => {
      const execute = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const triggerSchema = z.object({
        inputData: z.string(),
      });

      const step1 = new Step({ id: 'step1', execute });

      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema,
      });

      workflow.step(step1).commit();

      const run = workflow.createRun();
      const results = await run.start({ triggerData: { inputData: 'test-input' } });

      const baseContext = {
        attempts: { step1: 0 },
        steps: {},
        triggerData: { inputData: 'test-input' },
        getStepResult: expect.any(Function),
      };

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining(baseContext),
          runId: results.runId,
        }),
      );
    });

    it('should resolve variables from trigger data', async () => {
      const execute = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const triggerSchema = z.object({
        inputData: z.object({
          nested: z.object({
            value: z.string(),
          }),
        }),
      });

      const step1 = new Step({ id: 'step1', execute });

      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema,
      });

      workflow
        .step(step1, {
          id: 'step1',
          variables: {
            tData: { step: 'trigger', path: '.' },
          },
        })
        .commit();

      const baseContext = {
        attempts: { step1: 0 },
        steps: {},
        triggerData: { inputData: { nested: { value: 'test' } } },
        getStepResult: expect.any(Function),
      };

      const run = workflow.createRun();
      await run.start({ triggerData: { inputData: { nested: { value: 'test' } } } });

      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          context: {
            ...baseContext,
            inputData: {
              tData: { inputData: { nested: { value: 'test' } } },
            },
            triggerData: { inputData: { nested: { value: 'test' } } },
          },
          runId: expect.any(String),
        }),
      );
    });

    it('should resolve variables from previous steps', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({
        nested: { value: 'step1-data' },
      });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success' });

      const step1 = new Step({
        id: 'step1',
        execute: step1Action,
        outputSchema: z.object({ nested: z.object({ value: z.string() }) }),
      });
      const step2 = new Step({
        id: 'step2',
        execute: step2Action,
        inputSchema: z.object({ previousValue: z.string() }),
      });

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow
        .step(step1)
        .then(step2, {
          id: 'step2',
          variables: {
            previousValue: { step: step1, path: 'nested.value' },
          },
        })
        .commit();

      const run = workflow.createRun();
      const results = await run.start();

      const baseContext = {
        attempts: { step1: 0, step2: 0 },
        steps: {},
        triggerData: {},
        getStepResult: expect.any(Function),
      };

      expect(step2Action).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            ...baseContext,
            steps: {
              step1: {
                output: {
                  nested: {
                    value: 'step1-data',
                  },
                },
                status: 'success',
              },
            },
            inputData: {
              previousValue: 'step1-data',
            },
          }),
          runId: results.runId,
        }),
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle step execution errors', async () => {
      const error = new Error('Step execution failed');
      const failingAction = vi.fn<any>().mockRejectedValue(error);

      const step1 = new Step({ id: 'step1', execute: failingAction });

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow.step(step1).commit();

      const run = workflow.createRun();

      await expect(run.start()).resolves.toMatchObject({
        results: {
          step1: {
            error: 'Step execution failed',
            status: 'failed',
          },
        },
        runId: expect.any(String),
      });
    });

    it('should handle variable resolution errors', async () => {
      const step1 = new Step({
        id: 'step1',
        execute: vi.fn<any>().mockResolvedValue({ data: 'success' }),
        outputSchema: z.object({ data: z.string() }),
      });
      const step2 = new Step({ id: 'step2', execute: vi.fn<any>() });

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow
        .step(step1)
        .then(step2, {
          id: 'step2',
          variables: {
            data: { step: step1, path: 'data' },
          },
        })
        .commit();

      const run = workflow.createRun();
      await expect(run.start()).resolves.toMatchObject({
        results: {
          step1: {
            status: 'success',
            output: {
              data: 'success',
            },
          },
          step2: {
            output: undefined,
            status: 'success',
          },
        },
        runId: expect.any(String),
      });
    });
  });

  describe('Complex Conditions', () => {
    it('should handle nested AND/OR conditions', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({
        status: 'partial',
        score: 75,
        flags: { isValid: true },
      });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'step2' });
      const step3Action = vi.fn<any>().mockResolvedValue({ result: 'step3' });

      const step1 = new Step({
        id: 'step1',
        execute: step1Action,
        outputSchema: z.object({
          status: z.string(),
          score: z.number(),
          flags: z.object({ isValid: z.boolean() }),
        }),
      });
      const step2 = new Step({
        id: 'step2',
        execute: step2Action,
        outputSchema: z.object({ result: z.string() }),
      });
      const step3 = new Step({ id: 'step3', execute: step3Action });

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow
        .step(step1)
        .then(step2, {
          id: 'step2',
          when: {
            and: [
              {
                or: [
                  {
                    ref: { step: step1, path: 'status' },
                    query: { $eq: 'success' },
                  },
                  {
                    and: [
                      {
                        ref: { step: step1, path: 'status' },
                        query: { $eq: 'partial' },
                      },
                      {
                        ref: { step: step1, path: 'score' },
                        query: { $gte: 70 },
                      },
                    ],
                  },
                ],
              },
              {
                ref: { step: step1, path: 'flags.isValid' },
                query: { $eq: true },
              },
            ],
          },
        })
        .then(step3, {
          id: 'step3',
          when: {
            or: [
              {
                ref: { step: step1, path: 'status' },
                query: { $eq: 'failed' },
              },
              {
                ref: { step: step1, path: 'score' },
                query: { $lt: 70 },
              },
            ],
          },
        })
        .commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step2Action).toHaveBeenCalled();
      expect(step3Action).not.toHaveBeenCalled();
      expect(result.results.step2).toEqual({ status: 'success', output: { result: 'step2' } });
    });
  });

  describe('Loops', () => {
    it('should run an until loop', async () => {
      const increment = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('increment')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const incrementStep = new Step({
        id: 'increment',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: increment,
      });

      const final = vi
        .fn()
        .mockImplementation(
          async ({ context }: { context: WorkflowContext<any, [typeof incrementStep, typeof finalStep]> }) => {
            return { finalValue: context.getStepResult(incrementStep).newValue };
          },
        );
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow<[typeof incrementStep, typeof finalStep]>({
        name: 'counter-workflow',
        triggerSchema: z.object({
          target: z.number(),
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(incrementStep)
        .until(async ({ context }) => {
          const res = context.getStepResult('increment');
          return (res?.newValue ?? 0) >= 12;
        }, incrementStep)
        .then(finalStep)
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { target: 10, startValue: 0 } });

      expect(increment).toHaveBeenCalledTimes(12);
      expect(final).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results.final.output).toEqual({ finalValue: 12 });
      // @ts-ignore
      expect(results.increment.output).toEqual({ newValue: 12 });
    });

    it('should run a while loop', async () => {
      const increment = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('increment')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const incrementStep = new Step({
        id: 'increment',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: increment,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        return { finalValue: context.getStepResult(incrementStep).newValue };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          target: z.number(),
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(incrementStep)
        .while(
          {
            ref: { step: incrementStep, path: 'newValue' },
            query: { $lt: 10 },
          },
          incrementStep,
        )
        .then(finalStep)
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { target: 10, startValue: 0 } });

      expect(increment).toHaveBeenCalledTimes(10);
      expect(final).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results.final.output).toEqual({ finalValue: 10 });
      // @ts-ignore
      expect(results.increment.output).toEqual({ newValue: 10 });
    });

    it('should run a while loop with a condition function', async () => {
      const increment = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('increment')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const incrementStep = new Step({
        id: 'increment',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: increment,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        return { finalValue: context.getStepResult('increment')?.newValue };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          target: z.number(),
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(incrementStep)
        .while(async ({ context }) => {
          const res = context.getStepResult<{ newValue: number }>('increment');
          return (res?.newValue ?? 0) < 10;
        }, incrementStep)
        .then(finalStep)
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { target: 10, startValue: 0 } });

      expect(increment).toHaveBeenCalledTimes(10);
      expect(final).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results.final.output).toEqual({ finalValue: 10 });
      // @ts-ignore
      expect(results.increment.output).toEqual({ newValue: 10 });
    });

    it('should run a while loop after a `.after` call', async () => {
      const step1Action = vi.fn();
      const step2Action = vi.fn();
      const step3Action = vi.fn();
      const step4Action = vi.fn();
      const step5Action = vi.fn();

      const step1 = new Step({
        id: 'step1',
        execute: step1Action,
      });

      const step2 = new Step({
        id: 'step2',
        execute: step2Action,
      });

      const step3 = new Step({
        id: 'step3',
        execute: step3Action,
      });

      const step4 = new Step({
        id: 'step4',
        execute: step4Action,
      });

      const step5 = new Step({
        id: 'step5',
        execute: step5Action,
      });

      const wf = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          target: z.number(),
          startValue: z.number(),
        }),
      });

      wf.step(step1)
        .then(step2)
        .after(step2)
        .while(async () => false, step3)
        .then(step4)
        .step(step5)
        .commit();

      const run = wf.createRun();
      await run.start({ triggerData: { target: 10, startValue: 0 } });

      expect(step5Action).toHaveBeenCalledTimes(1);
      expect(step4Action).toHaveBeenCalledTimes(1);
      expect(step3Action).toHaveBeenCalledTimes(0);
      expect(step2Action).toHaveBeenCalledTimes(1);
      expect(step1Action).toHaveBeenCalledTimes(1);
    });

    it('should run a `.step` call once after a while loop', async () => {
      const step1Action = vi.fn();
      const step2Action = vi.fn();
      const step3Action = vi.fn().mockImplementation(async () => {
        count++;
        return { count };
      });
      const step4Action = vi.fn();
      const step5Action = vi.fn();

      let count = 0;

      const step1 = new Step({
        id: 'step1',
        execute: step1Action,
      });

      const step2 = new Step({
        id: 'step2',
        execute: step2Action,
      });

      const step3 = new Step({
        id: 'step3',
        execute: step3Action,
      });

      const step4 = new Step({
        id: 'step4',
        execute: step4Action,
      });

      const step5 = new Step({
        id: 'step5',
        execute: step5Action,
      });

      const wf = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          target: z.number(),
          startValue: z.number(),
        }),
      });

      wf.step(step1)
        .then(step2)
        .after(step2)
        .while(async () => count < 10, step3)
        .then(step4)
        .step(step5)
        .commit();

      const run = wf.createRun();
      await run.start({ triggerData: { target: 10, startValue: 0 } });

      expect(step5Action).toHaveBeenCalledTimes(1);
      expect(step4Action).toHaveBeenCalledTimes(1);
      expect(step3Action).toHaveBeenCalledTimes(10);
      expect(step2Action).toHaveBeenCalledTimes(1);
      expect(step1Action).toHaveBeenCalledTimes(1);
    });
  });

  describe('testing variables in loops', () => {
    // Common test setup
    const setupTest = () => {
      const step1Action = vi.fn().mockImplementation(async () => {
        return { step1Value: 0 };
      });

      const step2Action = vi.fn().mockImplementation(async ({ context }) => {
        const step1Value = context.inputData.step1Value;
        const step2Value = context.getStepResult('step2')?.step2Value;
        const currentValue = (step1Value || 0) + (step2Value || 0);

        const newStep2Value = currentValue + (step1Value === undefined ? 0.5 : 1);

        return { step2Value: newStep2Value };
      });

      const step1 = new Step({
        id: 'step1',
        execute: step1Action,
        inputSchema: z.object({
          triggerValue: z.number(),
        }),
        outputSchema: z.object({
          step1Value: z.number(),
        }),
      });

      const step2 = new Step({
        id: 'step2',
        execute: step2Action,
        inputSchema: z.object({
          step1Value: z.number(),
        }),
        outputSchema: z.object({
          step2Value: z.number(),
        }),
      });

      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema: z.object({
          maxValue: z.number(),
        }),
      });

      workflow.step(step1);

      return { workflow, step1, step2, step2Action };
    };

    const runAssertions = async (workflow: any, step2Action: any, hasVariables: boolean = false) => {
      const run = workflow.createRun();
      const result = await run.start({ triggerData: { maxValue: 5 } });

      expect(step2Action).toHaveBeenCalledTimes(hasVariables ? 5 : 10); // Without variables, it takes twice as many calls due to 0.5 increments

      // Verify step2Action was called with correct input
      step2Action.mock.calls.forEach(([args]) => {
        if (hasVariables) {
          expect(args.context.inputData.step1Value).toBeDefined();
          expect(args.context.inputData.step1Value).toBe(0);
        } else {
          expect(args.context.inputData.step1Value).toBeUndefined();
        }
      });

      const step2Result = result.results['step2'];
      expect(step2Result.output.step2Value).toBe(5);
    };

    it('should not include workflow variables across while loop iterations with function condition', async () => {
      const { workflow, step2, step2Action } = setupTest();

      workflow
        .while(async ({ context }) => {
          const currentValue = context.getStepResult('step2')?.step2Value || 0;
          const maxValue = context.triggerData?.maxValue || 5;
          return currentValue < maxValue;
        }, step2)
        .commit();

      await runAssertions(workflow, step2Action);
    });

    it('should maintain workflow variables across while loop iterations with function condition', async () => {
      const { workflow, step1, step2, step2Action } = setupTest();

      workflow
        .while(
          async ({ context }) => {
            const currentValue = context.getStepResult('step2')?.step2Value || 0;
            const maxValue = context.triggerData?.maxValue || 5;
            return currentValue < maxValue;
          },
          step2,
          {
            step1Value: {
              step: step1,
              path: 'step1Value',
            },
          },
        )
        .commit();

      await runAssertions(workflow, step2Action, true);
    });

    it('should not include workflow variables across while loop iterations with query condition', async () => {
      const { workflow, step2, step2Action } = setupTest();

      workflow
        .while(
          {
            ref: { step: step2, path: 'step2Value' },
            query: { $lt: 5 },
          },
          step2,
        )
        .commit();

      await runAssertions(workflow, step2Action);
    });

    it('should maintain workflow variables across while loop iterations with query condition', async () => {
      const { workflow, step1, step2, step2Action } = setupTest();

      workflow
        .while(
          {
            ref: { step: step2, path: 'step2Value' },
            query: { $lt: 5 },
          },
          step2,
          {
            step1Value: {
              step: step1,
              path: 'step1Value',
            },
          },
        )
        .commit();

      await runAssertions(workflow, step2Action, true);
    });

    it('should not include workflow variables across until loop iterations with function condition', async () => {
      const { workflow, step2, step2Action } = setupTest();

      workflow
        .until(async ({ context }) => {
          const currentValue = context.getStepResult('step2')?.step2Value || 0;
          const maxValue = context.triggerData?.maxValue || 5;
          return currentValue >= maxValue;
        }, step2)
        .commit();

      await runAssertions(workflow, step2Action);
    });

    it('should maintain workflow variables across until loop iterations with function condition', async () => {
      const { workflow, step1, step2, step2Action } = setupTest();

      workflow
        .until(
          async ({ context }) => {
            const currentValue = context.getStepResult('step2')?.step2Value || 0;
            const maxValue = context.triggerData?.maxValue || 5;
            return currentValue >= maxValue;
          },
          step2,
          {
            step1Value: {
              step: step1,
              path: 'step1Value',
            },
          },
        )
        .commit();

      await runAssertions(workflow, step2Action, true);
    });

    it('should not include workflow variables across until loop iterations with query condition', async () => {
      const { workflow, step2, step2Action } = setupTest();

      workflow
        .until(
          {
            ref: { step: step2, path: 'step2Value' },
            query: { $gte: 5 },
          },
          step2,
        )
        .commit();

      await runAssertions(workflow, step2Action);
    });

    it('should maintain workflow variables across until loop iterations with query condition', async () => {
      const { workflow, step1, step2, step2Action } = setupTest();

      workflow
        .until(
          {
            ref: { step: step2, path: 'step2Value' },
            query: { $gte: 5 },
          },
          step2,
          {
            step1Value: {
              step: step1,
              path: 'step1Value',
            },
          },
        )
        .commit();

      await runAssertions(workflow, step2Action, true);
    });
  });

  describe('if-else branching', () => {
    it('should run the if-then branch', async () => {
      const start = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const startStep = new Step({
        id: 'start',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: start,
      });

      const other = vi.fn().mockImplementation(async () => {
        return { other: 26 };
      });
      const otherStep = new Step({
        id: 'other',
        description: 'Other step',
        execute: other,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        const startVal = context.getStepResult('start')?.newValue ?? 0;
        const otherVal = context.getStepResult('other')?.other ?? 0;
        return { finalValue: startVal + otherVal };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(startStep)
        .if(async ({ context }) => {
          const current = context.getStepResult<{ newValue: number }>('start')?.newValue;
          return !current || current < 5;
        })
        .then(finalStep)
        .else()
        .then(otherStep)
        .then(finalStep)
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { startValue: 1 } });

      expect(start).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(0);
      expect(final).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results.final.output).toEqual({ finalValue: 2 });
      // @ts-ignore
      expect(results.start.output).toEqual({ newValue: 2 });
    });

    it('should run the else branch', async () => {
      const start = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const startStep = new Step({
        id: 'start',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: start,
      });

      const other = vi.fn().mockImplementation(async () => {
        return { other: 26 };
      });
      const otherStep = new Step({
        id: 'other',
        description: 'Other step',
        execute: other,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        const startVal = context.getStepResult('start')?.newValue ?? 0;
        const otherVal = context.getStepResult('other')?.other ?? 0;
        return { finalValue: startVal + otherVal };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(startStep)
        .if(async ({ context }) => {
          const current = context.getStepResult<{ newValue: number }>('start')?.newValue;
          return !current || current < 5;
        })
        .then(finalStep)
        .else()
        .then(otherStep)
        .then(finalStep)
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { startValue: 6 } });

      expect(start).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
      expect(final).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results.start.output).toEqual({ newValue: 7 });
      // @ts-ignore
      expect(results.other.output).toEqual({ other: 26 });

      // @ts-ignore
      expect(results.final.output).toEqual({ finalValue: 26 + 7 });
    });

    it('should run the else branch (when query)', async () => {
      const start = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const startStep = new Step({
        id: 'start',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: start,
      });

      const other = vi.fn().mockImplementation(async () => {
        return { other: 26 };
      });
      const otherStep = new Step({
        id: 'other',
        description: 'Other step',
        execute: other,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        const startVal = context.getStepResult('start')?.newValue ?? 0;
        const otherVal = context.getStepResult('other')?.other ?? 0;
        return { finalValue: startVal + otherVal };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(startStep)
        .if({
          ref: { step: startStep, path: 'newValue' },
          query: { $lt: 5 },
        })
        .then(finalStep)
        .else()
        .then(otherStep)
        .then(finalStep)
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { startValue: 6 } });

      expect(start).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
      expect(final).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results.start.output).toEqual({ newValue: 7 });
      // @ts-ignore
      expect(results.other.output).toEqual({ other: 26 });

      // @ts-ignore
      expect(results.final.output).toEqual({ finalValue: 26 + 7 });
    });

    it('should run else-then and a nested if-then branch', async () => {
      const start = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const startStep = new Step({
        id: 'start',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: start,
      });

      const other = vi.fn().mockImplementation(async () => {
        return { other: 26 };
      });
      const otherStep = new Step({
        id: 'other',
        description: 'Other step',
        execute: other,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        const startVal = context.getStepResult('start')?.newValue ?? 0;
        const otherVal = context.getStepResult('other')?.other ?? 0;
        return { finalValue: startVal + otherVal };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(startStep)
        .if(async ({ context }) => {
          const current = context.getStepResult<{ newValue: number }>('start')?.newValue;
          return !current || current > 5;
        })
        .then(finalStep)
        .else()
        .if(async ({ context }) => {
          const current = context.getStepResult<{ newValue: number }>('start')?.newValue;
          return current === 2;
        })
        .then(otherStep)
        .then(finalStep)
        .else()
        .then(finalStep)
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { startValue: 1 } });

      expect(start).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
      expect(final).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results.start.output).toEqual({ newValue: 2 });
      // @ts-ignore
      expect(results.other.output).toEqual({ other: 26 });

      // @ts-ignore
      expect(results.final.output).toEqual({ finalValue: 26 + 2 });
    });

    it('should run if-then and a nested else-then branch', async () => {
      const start = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const startStep = new Step({
        id: 'start',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: start,
      });

      const other = vi.fn().mockImplementation(async () => {
        return { other: 26 };
      });
      const otherStep = new Step({
        id: 'other',
        description: 'Other step',
        execute: other,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        const startVal = context.getStepResult('start')?.newValue ?? 0;
        const otherVal = context.getStepResult('other')?.other ?? 0;
        return { finalValue: startVal + otherVal };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(startStep)
        .if(async ({ context }) => {
          const current = context.getStepResult<{ newValue: number }>('start')?.newValue;
          return !current || current < 5;
        })
        .if(async ({ context }) => {
          const current = context.getStepResult<{ newValue: number }>('start')?.newValue;
          return current === 2;
        })
        .then(otherStep)
        .then(finalStep)
        .else()
        .then(finalStep)

        .else()
        .then(finalStep)
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { startValue: 1 } });

      expect(start).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
      expect(final).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results.start.output).toEqual({ newValue: 2 });
      // @ts-ignore
      expect(results.other.output).toEqual({ other: 26 });

      // @ts-ignore
      expect(results.final.output).toEqual({ finalValue: 26 + 2 });
    });

    it('should run if-else in order', async () => {
      const order: string[] = [];

      const step1Action = vi.fn().mockImplementation(async () => {
        order.push('step1');
      });
      const step2Action = vi.fn().mockImplementation(async () => {
        order.push('step2');
      });
      const step3Action = vi.fn().mockImplementation(async () => {
        order.push('step3');
      });
      const step4Action = vi.fn().mockImplementation(async () => {
        order.push('step4');
      });
      const step5Action = vi.fn().mockImplementation(async () => {
        order.push('step5');
      });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });
      const step3 = new Step({ id: 'step3', execute: step3Action });
      const step4 = new Step({ id: 'step4', execute: step4Action });
      const step5 = new Step({ id: 'step5', execute: step5Action });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow
        .step(step1)
        .if(async () => true)
        .then(step2)
        .if(async () => false)
        .then(step3)
        .else()
        .then(step4)
        .else()
        .then(step5)
        .commit();

      const run = workflow.createRun();
      await run.start();

      expect(step1Action).toHaveBeenCalledTimes(1);
      expect(step2Action).toHaveBeenCalledTimes(1);
      expect(step3Action).not.toHaveBeenCalled();
      expect(step4Action).toHaveBeenCalledTimes(1);
      expect(step5Action).not.toHaveBeenCalled();
      expect(order).toEqual(['step1', 'step2', 'step4']);
    });

    it('should run stacked if-else in order', async () => {
      const order: string[] = [];

      const step1Action = vi.fn().mockImplementation(async () => {
        order.push('step1');
      });
      const step2Action = vi.fn().mockImplementation(async () => {
        order.push('step2');
      });
      const step3Action = vi.fn().mockImplementation(async () => {
        order.push('step3');
      });
      const step4Action = vi.fn().mockImplementation(async () => {
        order.push('step4');
      });
      const step5Action = vi.fn().mockImplementation(async () => {
        order.push('step5');
      });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });
      const step3 = new Step({ id: 'step3', execute: step3Action });
      const step4 = new Step({ id: 'step4', execute: step4Action });
      const step5 = new Step({ id: 'step5', execute: step5Action });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow
        .step(step1)
        .if(async () => true)
        .then(step2)
        .else()
        .then(step4)
        .if(async () => false)
        .then(step3)
        .else()
        .then(step5)
        .commit();

      const run = workflow.createRun();
      await run.start();

      expect(step1Action).toHaveBeenCalledTimes(1);
      expect(step2Action).toHaveBeenCalledTimes(1);
      expect(step3Action).not.toHaveBeenCalled();
      expect(step4Action).not.toHaveBeenCalled();
      expect(step5Action).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['step1', 'step2', 'step5']);
    });

    it('should run an until loop inside an if-then branch', async () => {
      const increment = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('increment')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const other = vi.fn().mockImplementation(async () => {
        return { other: 26 };
      });
      const incrementStep = new Step({
        id: 'increment',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: increment,
      });

      const otherStep = new Step({
        id: 'other',
        description: 'Other step',
        execute: other,
      });

      const final = vi
        .fn()
        .mockImplementation(
          async ({ context }: { context: WorkflowContext<any, [typeof incrementStep, typeof finalStep]> }) => {
            return { finalValue: context.getStepResult(incrementStep).newValue };
          },
        );
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow<[typeof incrementStep, typeof finalStep]>({
        name: 'counter-workflow',
        triggerSchema: z.object({
          target: z.number(),
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(incrementStep)
        .if(async () => {
          return false;
        })
        .then(incrementStep)
        .until(async ({ context }) => {
          const res = context.getStepResult('increment');
          return (res?.newValue ?? 0) >= 12;
        }, incrementStep)
        .then(finalStep)
        .else()
        .then(otherStep)
        .then(finalStep)
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { target: 10, startValue: 0 } });

      expect(increment).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
      expect(final).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results.final.output).toEqual({ finalValue: 1 });
      // @ts-ignore
      expect(results.increment.output).toEqual({ newValue: 1 });
    });
  });

  describe('Schema Validation', () => {
    it('should validate trigger data against schema', async () => {
      const triggerSchema = z.object({
        required: z.string(),
        nested: z.object({
          value: z.number(),
        }),
      });

      const step1 = new Step({
        id: 'step1',
        execute: vi.fn<any>().mockResolvedValue({ result: 'success' }),
      });

      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema,
      });

      workflow.step(step1).commit();

      // // Should fail validation
      // await expect(
      //   workflow.execute({
      //     triggerData: {
      //       required: 'test',
      //       // @ts-expect-error
      //       nested: { value: 'not-a-number' },
      //     },
      //   }),
      // ).rejects.toThrow();

      // Should pass validation
      const run = workflow.createRun();
      await run.start({
        triggerData: {
          required: 'test',
          nested: { value: 42 },
        },
      });
    });
  });

  describe('Action Context', () => {
    it('should pass the correct context to the action', async () => {
      const action1 = vi.fn().mockResolvedValue({ result: 'success1' });
      const action2 = vi.fn().mockResolvedValue({ result: 'success2' });
      const action3 = vi.fn().mockResolvedValue({ result: 'success3' });
      const action4 = vi.fn().mockResolvedValue({ result: 'success4' });
      const action5 = vi.fn().mockResolvedValue({ result: 'success5' });

      const step1 = new Step({ id: 'step1', execute: action1 });
      const step2 = new Step({ id: 'step2', execute: action2, payload: { name: 'Dero Israel' } });
      const step3 = new Step({ id: 'step3', execute: action3 });
      const step4 = new Step({ id: 'step4', execute: action4 });
      const step5 = new Step({ id: 'step5', execute: action5 });

      const baseContext = {
        attempts: { step1: 0, step2: 0, step3: 0, step4: 0, step5: 0 },
        steps: {},
        inputData: {},
        triggerData: {},
        getStepResult: expect.any(Function),
      };

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow.step(step1).then(step2).then(step3).step(step4).then(step5).commit();

      const run = workflow.createRun();
      await run.start();

      expect(action1).toHaveBeenCalledWith(
        expect.objectContaining({
          mastra: undefined,
          context: expect.objectContaining(baseContext),
          suspend: expect.any(Function),
          runId: expect.any(String),
        }),
      );
      expect(action2).toHaveBeenCalledWith(
        expect.objectContaining({
          mastra: undefined,
          context: {
            ...baseContext,
            steps: {
              step1: { status: 'success', output: { result: 'success1' } },
              step4: { status: 'success', output: { result: 'success4' } },
            },
            inputData: {
              name: 'Dero Israel',
            },
          },
          suspend: expect.any(Function),
          runId: expect.any(String),
        }),
      );
      expect(action3).toHaveBeenCalledWith(
        expect.objectContaining({
          mastra: undefined,
          context: expect.objectContaining({
            ...baseContext,
            steps: {
              step1: { status: 'success', output: { result: 'success1' } },
              step2: { status: 'success', output: { result: 'success2' } },
              step4: { status: 'success', output: { result: 'success4' } },
              step5: { status: 'success', output: { result: 'success5' } },
            },
          }),
          suspend: expect.any(Function),
          runId: expect.any(String),
        }),
      );
      expect(action5).toHaveBeenCalledWith(
        expect.objectContaining({
          mastra: undefined,
          context: expect.objectContaining({
            ...baseContext,
            steps: {
              step1: { status: 'success', output: { result: 'success1' } },
              step4: { status: 'success', output: { result: 'success4' } },
            },
          }),
          suspend: expect.any(Function),
          runId: expect.any(String),
        }),
      );
    });
  });

  describe('multiple chains', () => {
    it('should run multiple chains in parallel', async () => {
      const step1 = new Step({ id: 'step1', execute: vi.fn<any>().mockResolvedValue({ result: 'success1' }) });
      const step2 = new Step({ id: 'step2', execute: vi.fn<any>().mockResolvedValue({ result: 'success2' }) });
      const step3 = new Step({ id: 'step3', execute: vi.fn<any>().mockResolvedValue({ result: 'success3' }) });
      const step4 = new Step({ id: 'step4', execute: vi.fn<any>().mockResolvedValue({ result: 'success4' }) });
      const step5 = new Step({ id: 'step5', execute: vi.fn<any>().mockResolvedValue({ result: 'success5' }) });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).then(step2).then(step3).step(step4).then(step5).commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success1' } });
      expect(result.results.step2).toEqual({ status: 'success', output: { result: 'success2' } });
      expect(result.results.step3).toEqual({ status: 'success', output: { result: 'success3' } });
      expect(result.results.step4).toEqual({ status: 'success', output: { result: 'success4' } });
      expect(result.results.step5).toEqual({ status: 'success', output: { result: 'success5' } });
    });
  });

  describe('Retry', () => {
    it('should retry a step default 0 times', async () => {
      const step1 = new Step({ id: 'step1', execute: vi.fn<any>().mockResolvedValue({ result: 'success' }) });
      const step2 = new Step({ id: 'step2', execute: vi.fn<any>().mockRejectedValue(new Error('Step failed')) });

      const mastra = new Mastra({
        logger: createLogger({
          name: 'Workflow',
        }),
        storage,
      });

      const workflow = new Workflow({
        name: 'test-workflow',
        mastra,
      });

      workflow.step(step1).then(step2).commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success' } });
      expect(result.results.step2).toEqual({ status: 'failed', error: 'Step failed' });
      expect(step1.execute).toHaveBeenCalledTimes(1);
      expect(step2.execute).toHaveBeenCalledTimes(1); // 0 retries + 1 initial call
    });

    it('should retry a step with a custom retry config', async () => {
      const step1 = new Step({ id: 'step1', execute: vi.fn<any>().mockResolvedValue({ result: 'success' }) });
      const step2 = new Step({ id: 'step2', execute: vi.fn<any>().mockRejectedValue(new Error('Step failed')) });

      const mastra = new Mastra({
        logger: createLogger({
          name: 'Workflow',
        }),
        storage,
      });

      const workflow = new Workflow({
        name: 'test-workflow',
        mastra,
        retryConfig: { attempts: 5, delay: 200 },
      });

      workflow.step(step1).then(step2).commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success' } });
      expect(result.results.step2).toEqual({ status: 'failed', error: 'Step failed' });
      expect(step1.execute).toHaveBeenCalledTimes(1);
      expect(step2.execute).toHaveBeenCalledTimes(6); // 5 retries + 1 initial call
    });
  });

  describe('Subscribers (.after)', () => {
    it('should spawn subscribers for each step', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success2' });
      const step3Action = vi.fn<any>().mockResolvedValue({ result: 'success3' });
      const step4Action = vi.fn<any>().mockResolvedValue({ result: 'success4' });
      const step5Action = vi.fn<any>().mockResolvedValue({ result: 'success5' });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });
      const step3 = new Step({ id: 'step3', execute: step3Action });
      const step4 = new Step({ id: 'step4', execute: step4Action });
      const step5 = new Step({ id: 'step5', execute: step5Action });
      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).then(step2).then(step5).after(step1).step(step3).then(step4).then(step5).commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).toHaveBeenCalled();
      expect(step3Action).toHaveBeenCalled();
      expect(step4Action).toHaveBeenCalled();
      expect(step5Action).toHaveBeenCalledTimes(2);
      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success1' } });
      expect(result.results.step2).toEqual({ status: 'success', output: { result: 'success2' } });
      expect(result.results.step3).toEqual({ status: 'success', output: { result: 'success3' } });
      expect(result.results.step4).toEqual({ status: 'success', output: { result: 'success4' } });
      expect(result.results.step5).toEqual({ status: 'success', output: { result: 'success5' } });
    });

    it('should conditionally run subscribers', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success2' });
      const step3Action = vi.fn<any>().mockResolvedValue({ result: 'success3' });
      const step4Action = vi.fn<any>().mockResolvedValue({ result: 'success4' });
      const step5Action = vi.fn<any>().mockResolvedValue({ result: 'success5' });

      const step1 = new Step({ id: 'step1', execute: step1Action, outputSchema: z.object({ status: z.string() }) });
      const step2 = new Step({ id: 'step2', execute: step2Action });
      const step3 = new Step({ id: 'step3', execute: step3Action });
      const step4 = new Step({ id: 'step4', execute: step4Action });
      const step5 = new Step({ id: 'step5', execute: step5Action });
      const workflow = new Workflow({ name: 'test-workflow' });
      workflow
        .step(step1)
        .then(step2)
        .then(step5)
        .after(step1)
        .step(step3, {
          id: 'step3',
          when: {
            ref: { step: step1, path: 'status' },
            query: { $eq: 'failed' },
          },
        })
        .then(step4)
        .then(step5)
        .commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).toHaveBeenCalled();
      expect(step3Action).not.toHaveBeenCalled();
      expect(step4Action).not.toHaveBeenCalled();
      expect(step5Action).toHaveBeenCalledTimes(1);
      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success1' } });
      expect(result.results.step2).toEqual({ status: 'success', output: { result: 'success2' } });
      expect(result.results.step5).toEqual({ status: 'success', output: { result: 'success5' } });
    });

    it('should run compound subscribers', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success2' });
      const step3Action = vi.fn<any>().mockResolvedValue({ result: 'success3' });
      const step4Action = vi.fn<any>().mockResolvedValue({ result: 'success4' });
      const step5Action = vi.fn<any>().mockResolvedValue({ result: 'success5' });

      const step1 = new Step({ id: 'step1', execute: step1Action, outputSchema: z.object({ status: z.string() }) });
      const step2 = new Step({ id: 'step2', execute: step2Action });
      const step3 = new Step({ id: 'step3', execute: step3Action });
      const step4 = new Step({ id: 'step4', execute: step4Action });
      const step5 = new Step({ id: 'step5', execute: step5Action });
      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).then(step2).then(step5).after([step1, step5]).step(step3).then(step4).then(step5).commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).toHaveBeenCalled();
      expect(step3Action).toHaveBeenCalled();
      expect(step4Action).toHaveBeenCalled();
      expect(step5Action).toHaveBeenCalledTimes(2);
      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success1' } });
      expect(result.results.step2).toEqual({ status: 'success', output: { result: 'success2' } });
      expect(result.results.step5).toEqual({ status: 'success', output: { result: 'success5' } });
    });

    it('should run compound subscribers with overlapping keys', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success2' });
      const step3Action = vi.fn<any>().mockResolvedValue({ result: 'success3' });
      const step4Action = vi.fn<any>().mockResolvedValue({ result: 'success4' });

      const step1 = new Step({ id: 'step1', execute: step1Action, outputSchema: z.object({ status: z.string() }) });
      const step2 = new Step({ id: 'step2', execute: step2Action });
      const step3 = new Step({ id: 'step3', execute: step3Action });
      const step4 = new Step({ id: 'step4', execute: step4Action });
      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).after(step1).step(step2).after([step1, step2]).step(step3).then(step4).commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).toHaveBeenCalled();
      expect(step3Action).toHaveBeenCalled();
      expect(step4Action).toHaveBeenCalled();
      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success1' } });
      expect(result.results.step2).toEqual({ status: 'success', output: { result: 'success2' } });
    });

    it('should run compound subscribers with when conditions', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success2' });
      const step3Action = vi.fn<any>().mockResolvedValue({ result: 'success3' });
      const step4Action = vi.fn<any>().mockResolvedValue({ result: 'success4' });
      const step5Action = vi.fn<any>().mockResolvedValue({ result: 'success5' });

      const step1 = new Step({ id: 'step1', execute: step1Action, outputSchema: z.object({ status: z.string() }) });
      const step2 = new Step({ id: 'step2', execute: step2Action });
      const step3 = new Step({ id: 'step3', execute: step3Action });
      const step4 = new Step({ id: 'step4', execute: step4Action });
      const step5 = new Step({ id: 'step5', execute: step5Action });
      const workflow = new Workflow({ name: 'test-workflow' });
      workflow
        .step(step1, { id: 'step1' })
        .then(step2, { id: 'step2', when: async () => false })
        .after([step1, step2])
        .step(step3, { id: 'step3' })
        .then(step4, { id: 'step4' })
        .then(step5, { id: 'step5' })
        .commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).not.toHaveBeenCalled();
      expect(step3Action).toHaveBeenCalled();
      expect(step4Action).toHaveBeenCalled();
      expect(step5Action).toHaveBeenCalledTimes(1);
      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success1' } });
      expect(result.results.step2).toEqual({ status: 'skipped' });
      expect(result.results.step5).toEqual({ status: 'success', output: { result: 'success5' } });
    });

    it('should run complex compound subscribers', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success2' });
      const step3Action = vi.fn<any>().mockResolvedValue({ result: 'success3' });
      const step4Action = vi.fn<any>().mockResolvedValue({ result: 'success4' });
      const step5Action = vi.fn<any>().mockResolvedValue({ result: 'success5' });
      const step6Action = vi.fn<any>().mockResolvedValue({ result: 'success6' });
      const step7Action = vi.fn<any>().mockResolvedValue({ result: 'success7' });
      const step8Action = vi.fn<any>().mockResolvedValue({ result: 'success8' });

      const step1 = new Step({ id: 'step1', execute: step1Action, outputSchema: z.object({ status: z.string() }) });
      const step2 = new Step({ id: 'step2', execute: step2Action });
      const step3 = new Step({ id: 'step3', execute: step3Action });
      const step4 = new Step({ id: 'step4', execute: step4Action });
      const step5 = new Step({ id: 'step5', execute: step5Action });
      const step6 = new Step({ id: 'step6', execute: step6Action });
      const step7 = new Step({ id: 'step7', execute: step7Action });
      const step8 = new Step({ id: 'step8', execute: step8Action });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow
        .step(step1)
        .then(step2)
        .then(step5)
        .after([step1, step5])
        .step(step3)
        .then(step4)
        .then(step5)
        .after([step3, step4])
        .step(step6)
        .then(step8)
        .then(step7)
        .after(step5)
        .step(step8)
        .commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step1Action).toHaveBeenCalled();
      expect(step2Action).toHaveBeenCalled();
      expect(step3Action).toHaveBeenCalled();
      expect(step4Action).toHaveBeenCalled();
      expect(step5Action).toHaveBeenCalledTimes(2);
      expect(step6Action).toHaveBeenCalled();
      expect(step7Action).toHaveBeenCalled();
      expect(step8Action).toHaveBeenCalledTimes(3);
      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success1' } });
      expect(result.results.step2).toEqual({ status: 'success', output: { result: 'success2' } });
      expect(result.results.step5).toEqual({ status: 'success', output: { result: 'success5' } });
    });

    it('should run compound subscribers on a loop', async () => {
      const increment = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('increment')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const incrementStep = new Step({
        id: 'increment',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: increment,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        return { finalValue: context.getStepResult(incrementStep).newValue };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: async (...rest) => {
          return final(...rest);
        },
      });

      const mockAction = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const dummyStep = new Step({
        id: 'dummy',
        description: 'Dummy step',
        execute: async (...rest) => {
          return mockAction(...rest);
        },
      });

      const mockAction2 = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const dummyStep2 = new Step({
        id: 'dummy2',
        description: 'Dummy step',
        execute: async (...rest) => {
          return mockAction2(...rest);
        },
      });

      const mockAction3 = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const dummyStep3 = new Step({
        id: 'dummy3',
        description: 'Dummy step',
        execute: async (...rest) => {
          return mockAction3(...rest);
        },
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          target: z.number(),
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(incrementStep)
        .after(incrementStep)
        .step(dummyStep)
        .after(incrementStep)
        .step(dummyStep2)
        .after([dummyStep, dummyStep2])
        .step(dummyStep3)
        .after(dummyStep3)
        .step(incrementStep, {
          when: async ({ context }) => {
            const isPassed = context.getStepResult(incrementStep)?.newValue < 10;
            if (isPassed) {
              return true;
            } else {
              return WhenConditionReturnValue.LIMBO;
            }
          },
        })
        .step(finalStep, {
          id: 'finalStep',
          when: async ({ context }) => {
            const isPassed = context.getStepResult(incrementStep)?.newValue >= 10;
            return isPassed;
          },
        })
        .commit();

      const run = counterWorkflow.createRun();
      await run.start({ triggerData: { target: 10, startValue: 0 } });

      expect(increment).toHaveBeenCalledTimes(10);
      expect(mockAction).toHaveBeenCalledTimes(10);
      expect(mockAction2).toHaveBeenCalledTimes(10);
      expect(mockAction3).toHaveBeenCalledTimes(10);
      expect(final).toHaveBeenCalledTimes(1);
    });

    // don't unskip
    it.skip('should spawn cyclic subscribers for each step (legacy)', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step3Action = vi.fn<any>().mockResolvedValue({ result: 'success3' });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step3 = new Step({ id: 'step3', execute: step3Action });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).step(step3).after(step1).step(step3).after(step3).step(step1).commit();

      const run = workflow.createRun();
      const result = await run.start();

      expect(step1Action).toHaveBeenCalled();

      expect(step3Action).toHaveBeenCalled();
      expect(result.results.step1).toEqual({ status: 'success', output: { result: 'success1' } });
      expect(result.results.step3).toEqual({ status: 'success', output: { result: 'success3' } });
    });
  });

  describe('Interoperability (Actions)', () => {
    it('should be able to use all action types in a workflow', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ name: 'step1' });

      const step1 = new Step({ id: 'step1', execute: step1Action, outputSchema: z.object({ name: z.string() }) });

      const toolAction = vi.fn<any>().mockResolvedValue({ age: 100 });

      const randomTool = createTool({
        id: 'random-tool',
        execute: toolAction,
        description: 'random-tool',
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ age: z.number() }),
      });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).after(step1).step(randomTool).commit();

      await workflow.createRun().start();

      expect(step1Action).toHaveBeenCalled();
      expect(toolAction).toHaveBeenCalled();
    }, 10000);
  });

  describe('Watch', () => {
    it('should watch workflow state changes and call onTransition', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success2' });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).then(step2).commit();

      const onTransition = vi.fn();

      const run = workflow.createRun();

      // Start watching the workflow
      run.watch(onTransition);

      const executionResult = await run.start();

      expect(onTransition).toHaveBeenCalledTimes(6);
      expect(onTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.any(String),
          results: {
            step1: {
              output: {
                result: 'success1',
              },
              status: 'success',
            },
          },
          activePaths: new Map([
            [
              'step1',
              {
                status: 'runningSubscribers',
              },
            ],
          ]),
          timestamp: expect.any(Number),
        }),
      );

      // Verify execution completed successfully
      expect(executionResult.results.step1).toEqual({
        status: 'success',
        output: { result: 'success1' },
      });
      expect(executionResult.results.step2).toEqual({
        status: 'success',
        output: { result: 'success2' },
      });
    });

    it('should unsubscribe from transitions when unwatch is called', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success2' });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).then(step2).commit();

      const onTransition = vi.fn();
      const onTransition2 = vi.fn();

      const run = workflow.createRun();

      run.watch(onTransition);
      run.watch(onTransition2);

      await run.start();

      expect(onTransition).toHaveBeenCalledTimes(6);
      expect(onTransition2).toHaveBeenCalledTimes(6);

      const run2 = workflow.createRun();

      run2.watch(onTransition2);

      await run2.start();

      expect(onTransition).toHaveBeenCalledTimes(6);
      expect(onTransition2).toHaveBeenCalledTimes(12);

      const run3 = workflow.createRun();

      run3.watch(onTransition);

      await run3.start();

      expect(onTransition).toHaveBeenCalledTimes(12);
      expect(onTransition2).toHaveBeenCalledTimes(12);
    });

    it('should handle parallel transitions', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success2' });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).step(step2).commit();

      const onTransition = vi.fn();

      const run = workflow.createRun();

      run.watch(onTransition);

      await run.start();

      expect(onTransition).toHaveBeenCalledTimes(6);
      expect(onTransition).toHaveBeenCalledWith(
        expect.objectContaining({
          activePaths: new Map([
            ['step1', { status: 'runningSubscribers' }],
            ['step2', { status: 'runningSubscribers' }],
          ]),
        }),
      );
    });
  });

  describe('Suspend and Resume', () => {
    afterAll(async () => {
      const pathToDb = path.join(process.cwd(), 'mastra.db');

      if (fs.existsSync(pathToDb)) {
        fs.rmSync(pathToDb);
      }
    });
    it('should return the correct runId', async () => {
      const workflow = new Workflow({ name: 'test-workflow' });
      const run = workflow.createRun();
      const run2 = workflow.createRun({ runId: run.runId });

      expect(run.runId).toBeDefined();
      expect(run2.runId).toBeDefined();
      expect(run.runId).toBe(run2.runId);
    });
    it('should handle basic suspend and resume flow', async () => {
      const getUserInputAction = vi.fn().mockResolvedValue({ userInput: 'test input' });
      const promptAgentAction = vi
        .fn()
        .mockImplementationOnce(async ({ suspend }) => {
          await suspend();
          return undefined;
        })
        .mockImplementationOnce(() => ({ modelOutput: 'test output' }));
      const evaluateToneAction = vi.fn().mockResolvedValue({
        toneScore: { score: 0.8 },
        completenessScore: { score: 0.7 },
      });
      const improveResponseAction = vi.fn().mockResolvedValue({ improvedOutput: 'improved output' });
      const evaluateImprovedAction = vi.fn().mockResolvedValue({
        toneScore: { score: 0.9 },
        completenessScore: { score: 0.8 },
      });

      const getUserInput = new Step({
        id: 'getUserInput',
        execute: getUserInputAction,
        outputSchema: z.object({ userInput: z.string() }),
      });
      const promptAgent = new Step({
        id: 'promptAgent',
        execute: promptAgentAction,
        outputSchema: z.object({ modelOutput: z.string() }),
      });
      const evaluateTone = new Step({
        id: 'evaluateToneConsistency',
        execute: evaluateToneAction,
        outputSchema: z.object({
          toneScore: z.any(),
          completenessScore: z.any(),
        }),
      });
      const improveResponse = new Step({
        id: 'improveResponse',
        execute: improveResponseAction,
        outputSchema: z.object({ improvedOutput: z.string() }),
      });
      const evaluateImproved = new Step({
        id: 'evaluateImprovedResponse',
        execute: evaluateImprovedAction,
        outputSchema: z.object({
          toneScore: z.any(),
          completenessScore: z.any(),
        }),
      });

      const promptEvalWorkflow = new Workflow({
        name: 'test-workflow',
        triggerSchema: z.object({ input: z.string() }),
      });

      promptEvalWorkflow
        .step(getUserInput)
        .then(promptAgent)
        .then(evaluateTone)
        .then(improveResponse)
        .then(evaluateImproved)
        .commit();

      // Create a new storage instance for initial run
      const initialStorage = new DefaultStorage({
        config: {
          url: 'file::memory:',
        },
      });
      await initialStorage.init();

      const mastra = new Mastra({
        logger,
        storage: initialStorage,
        workflows: { 'test-workflow': promptEvalWorkflow },
      });

      const wf = mastra.getWorkflow('test-workflow');
      const run = wf.createRun();

      // Create a promise to track when the workflow is ready to resume
      let resolveWorkflowSuspended: (value: unknown) => void;
      const workflowSuspended = new Promise(resolve => {
        resolveWorkflowSuspended = resolve;
      });

      run.watch(data => {
        const isPromptAgentSuspended = data.activePaths.get('promptAgent')?.status === 'suspended';
        if (isPromptAgentSuspended) {
          const newCtx = {
            ...data.results,
          };
          // @ts-ignore
          newCtx.getUserInput.output = {
            userInput: 'test input for resumption',
          };
          resolveWorkflowSuspended({ stepId: 'promptAgent', context: newCtx });
        }
      });

      const initialResult = await run.start({ triggerData: { input: 'test' } });
      expect(initialResult.results.promptAgent.status).toBe('suspended');
      expect(promptAgentAction).toHaveBeenCalledTimes(1);

      // Wait for the workflow to be ready to resume
      const resumeData = await workflowSuspended;
      const resumeResult = await run.resume(resumeData as any);

      if (!resumeResult) {
        throw new Error('Resume failed to return a result');
      }

      expect(resumeResult.results).toEqual({
        getUserInput: { status: 'success', output: { userInput: 'test input for resumption' } },
        promptAgent: { status: 'success', output: { modelOutput: 'test output' } },
        evaluateToneConsistency: {
          status: 'success',
          output: { toneScore: { score: 0.8 }, completenessScore: { score: 0.7 } },
        },
        improveResponse: { status: 'success', output: { improvedOutput: 'improved output' } },
        evaluateImprovedResponse: {
          status: 'success',
          output: { toneScore: { score: 0.9 }, completenessScore: { score: 0.8 } },
        },
      });
    });

    it('should handle parallel steps with conditional suspend', async () => {
      const getUserInputAction = vi.fn().mockResolvedValue({ userInput: 'test input' });
      const promptAgentAction = vi.fn().mockResolvedValue({ modelOutput: 'test output' });
      const evaluateToneAction = vi.fn().mockResolvedValue({
        toneScore: { score: 0.8 },
        completenessScore: { score: 0.7 },
      });
      const humanInterventionAction = vi
        .fn()
        .mockImplementationOnce(async ({ suspend, context }) => {
          const { humanPrompt } = context.getStepResult('humanIntervention') ?? {};

          if (!humanPrompt) {
            await suspend();
          }
        })
        .mockImplementationOnce(() => ({ improvedOutput: 'human intervention output' }));
      const explainResponseAction = vi.fn().mockResolvedValue({
        improvedOutput: 'explanation output',
      });

      const getUserInput = new Step({
        id: 'getUserInput',
        execute: getUserInputAction,
        outputSchema: z.object({ userInput: z.string() }),
      });
      const promptAgent = new Step({
        id: 'promptAgent',
        execute: promptAgentAction,
        outputSchema: z.object({ modelOutput: z.string() }),
      });
      const evaluateTone = new Step({
        id: 'evaluateToneConsistency',
        execute: evaluateToneAction,
        outputSchema: z.object({
          toneScore: z.any(),
          completenessScore: z.any(),
        }),
      });
      const humanIntervention = new Step({
        id: 'humanIntervention',
        execute: humanInterventionAction,
        outputSchema: z.object({ improvedOutput: z.string() }),
      });
      const explainResponse = new Step({
        id: 'explainResponse',
        execute: explainResponseAction,
        outputSchema: z.object({ improvedOutput: z.string() }),
      });

      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema: z.object({ input: z.string() }),
      });

      workflow
        .step(getUserInput)
        .then(promptAgent)
        .then(evaluateTone)
        .after(evaluateTone)
        .step(humanIntervention, {
          id: 'humanIntervention',
          when: () => Promise.resolve(true),
        })
        .step(explainResponse, {
          id: 'explainResponse',
          when: () => Promise.resolve(false),
        })
        .commit();

      const mastra = new Mastra({
        logger,
        workflows: { 'test-workflow': workflow },
        storage,
      });

      const wf = mastra.getWorkflow('test-workflow');
      const run = wf.createRun();

      const started = run.start({ triggerData: { input: 'test' } });

      const result = await new Promise<WorkflowResumeResult<any>>((resolve, reject) => {
        let hasResumed = false;
        run.watch(async data => {
          const suspended = data.activePaths.get('humanIntervention');
          if (suspended?.status === 'suspended') {
            const newCtx = {
              ...data.results,
              humanPrompt: 'What improvements would you suggest?',
            };
            if (!hasResumed) {
              hasResumed = true;

              try {
                const resumed = await run.resume({
                  stepId: 'humanIntervention',
                  context: newCtx,
                });

                resolve(resumed as any);
              } catch (error) {
                reject(error);
              }
            }
          }
        });
      });

      const initialResult = await started;

      expect(initialResult.results.humanIntervention.status).toBe('suspended');
      expect(initialResult.results.explainResponse.status).toBe('skipped');
      expect(humanInterventionAction).toHaveBeenCalledTimes(2);
      expect(explainResponseAction).not.toHaveBeenCalled();

      if (!result) {
        throw new Error('Resume failed to return a result');
      }

      expect(result.results).toEqual({
        getUserInput: { status: 'success', output: { userInput: 'test input' } },
        promptAgent: { status: 'success', output: { modelOutput: 'test output' } },
        evaluateToneConsistency: {
          status: 'success',
          output: { toneScore: { score: 0.8 }, completenessScore: { score: 0.7 } },
        },
        humanIntervention: { status: 'success', output: { improvedOutput: 'human intervention output' } },
        explainResponse: { status: 'skipped' },
      });
    });

    it('should handle complex workflow with multiple suspends', async () => {
      const getUserInputAction = vi.fn().mockResolvedValue({ userInput: 'test input' });
      const promptAgentAction = vi.fn().mockResolvedValue({ modelOutput: 'test output' });

      const evaluateToneAction = vi.fn().mockResolvedValue({
        toneScore: { score: 0.8 },
        completenessScore: { score: 0.7 },
      });
      const improveResponseAction = vi
        .fn()
        .mockImplementationOnce(async ({ suspend }) => {
          await suspend();
        })
        .mockImplementationOnce(() => ({ improvedOutput: 'improved output' }));
      const evaluateImprovedAction = vi.fn().mockResolvedValue({
        toneScore: { score: 0.9 },
        completenessScore: { score: 0.8 },
      });
      const humanInterventionAction = vi
        .fn()
        .mockImplementationOnce(async ({ suspend }) => {
          await suspend();
        })
        .mockImplementationOnce(() => ({ improvedOutput: 'human intervention output' }));
      const explainResponseAction = vi.fn().mockResolvedValue({
        improvedOutput: 'explanation output',
      });

      const getUserInput = new Step({
        id: 'getUserInput',
        execute: getUserInputAction,
        outputSchema: z.object({ userInput: z.string() }),
      });
      const promptAgent = new Step({
        id: 'promptAgent',
        execute: promptAgentAction,
        outputSchema: z.object({ modelOutput: z.string() }),
      });
      const evaluateTone = new Step({
        id: 'evaluateToneConsistency',
        execute: evaluateToneAction,
        outputSchema: z.object({
          toneScore: z.any(),
          completenessScore: z.any(),
        }),
      });
      const improveResponse = new Step({
        id: 'improveResponse',
        execute: improveResponseAction,
        outputSchema: z.object({ improvedOutput: z.string() }),
      });
      const evaluateImproved = new Step({
        id: 'evaluateImprovedResponse',
        execute: evaluateImprovedAction,
        outputSchema: z.object({
          toneScore: z.any(),
          completenessScore: z.any(),
        }),
      });
      const humanIntervention = new Step({
        id: 'humanIntervention',
        execute: humanInterventionAction,
        outputSchema: z.object({ improvedOutput: z.string() }),
      });
      const explainResponse = new Step({
        id: 'explainResponse',
        execute: explainResponseAction,
        outputSchema: z.object({ improvedOutput: z.string() }),
      });

      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema: z.object({ input: z.string() }),
      });

      workflow
        .step(getUserInput)
        .then(promptAgent)
        .then(evaluateTone)
        .then(improveResponse)
        .then(evaluateImproved)
        .after(evaluateImproved)
        .step(humanIntervention, {
          id: 'humanIntervention',
          when: () => Promise.resolve(true),
        })
        .step(explainResponse, {
          id: 'explainResponse',
          when: () => Promise.resolve(false),
        })
        .commit();

      const mastra = new Mastra({
        logger,
        workflows: { 'test-workflow': workflow },
        storage,
      });

      const wf = mastra.getWorkflow('test-workflow');
      const run = wf.createRun();
      const started = run.start({ triggerData: { input: 'test' } });
      let improvedResponseResultPromise: Promise<WorkflowResumeResult<any> | undefined>;

      const result = await new Promise<WorkflowResumeResult<any>>((resolve, reject) => {
        let hasResumed = false;
        run.watch(async data => {
          const isHumanInterventionSuspended = data.activePaths.get('humanIntervention')?.status === 'suspended';
          const isImproveResponseSuspended = data.activePaths.get('improveResponse')?.status === 'suspended';

          if (isHumanInterventionSuspended) {
            const newCtx = {
              ...data.results,
              humanPrompt: 'What improvements would you suggest?',
            };
            if (!hasResumed) {
              hasResumed = true;

              try {
                const resumed = await run.resume({
                  stepId: 'humanIntervention',
                  context: newCtx,
                });
                resolve(resumed as any);
              } catch (error) {
                reject(error);
              }
            }
          } else if (isImproveResponseSuspended) {
            const resumed = run.resume({
              stepId: 'improveResponse',
              context: {
                ...data.results,
              },
            });
            improvedResponseResultPromise = resumed;
          }
        });
      });

      const initialResult = await started;

      // @ts-ignore
      const improvedResponseResult = await improvedResponseResultPromise;
      expect(initialResult?.results.improveResponse.status).toBe('suspended');

      expect(improvedResponseResult?.results.humanIntervention.status).toBe('suspended');
      expect(improvedResponseResult?.results.improveResponse.status).toBe('success');
      expect(improvedResponseResult?.results.evaluateImprovedResponse.status).toBe('success');
      expect(improvedResponseResult?.results.explainResponse.status).toBe('skipped');
      expect(humanInterventionAction).toHaveBeenCalledTimes(2);
      expect(explainResponseAction).not.toHaveBeenCalled();

      if (!result) {
        throw new Error('Resume failed to return a result');
      }

      expect(result.results).toEqual({
        getUserInput: { status: 'success', output: { userInput: 'test input' } },
        promptAgent: { status: 'success', output: { modelOutput: 'test output' } },
        evaluateToneConsistency: {
          status: 'success',
          output: { toneScore: { score: 0.8 }, completenessScore: { score: 0.7 } },
        },
        improveResponse: { status: 'success', output: { improvedOutput: 'improved output' } },
        evaluateImprovedResponse: {
          status: 'success',
          output: { toneScore: { score: 0.9 }, completenessScore: { score: 0.8 } },
        },
        humanIntervention: { status: 'success', output: { improvedOutput: 'human intervention output' } },
        explainResponse: { status: 'skipped' },
      });
    });

    it('should handle basic suspend and resume flow with async await syntax', async () => {
      const getUserInputAction = vi.fn().mockResolvedValue({ userInput: 'test input' });
      const promptAgentAction = vi
        .fn()
        .mockImplementationOnce(async ({ suspend }) => {
          await suspend({ testPayload: 'hello' });
          return undefined;
        })
        .mockImplementationOnce(() => ({ modelOutput: 'test output' }));
      const evaluateToneAction = vi.fn().mockResolvedValue({
        toneScore: { score: 0.8 },
        completenessScore: { score: 0.7 },
      });
      const improveResponseAction = vi
        .fn()
        .mockImplementationOnce(async ({ suspend }) => {
          await suspend();
          return undefined;
        })
        .mockImplementationOnce(() => ({ improvedOutput: 'improved output' }));
      const evaluateImprovedAction = vi.fn().mockResolvedValue({
        toneScore: { score: 0.9 },
        completenessScore: { score: 0.8 },
      });

      const getUserInput = new Step({
        id: 'getUserInput',
        execute: getUserInputAction,
        outputSchema: z.object({ userInput: z.string() }),
      });
      const promptAgent = new Step({
        id: 'promptAgent',
        execute: promptAgentAction,
        outputSchema: z.object({ modelOutput: z.string() }),
      });
      const evaluateTone = new Step({
        id: 'evaluateToneConsistency',
        execute: evaluateToneAction,
        outputSchema: z.object({
          toneScore: z.any(),
          completenessScore: z.any(),
        }),
      });
      const improveResponse = new Step({
        id: 'improveResponse',
        execute: improveResponseAction,
        outputSchema: z.object({ improvedOutput: z.string() }),
      });
      const evaluateImproved = new Step({
        id: 'evaluateImprovedResponse',
        execute: evaluateImprovedAction,
        outputSchema: z.object({
          toneScore: z.any(),
          completenessScore: z.any(),
        }),
      });

      const promptEvalWorkflow = new Workflow<
        [typeof getUserInput, typeof promptAgent, typeof evaluateTone, typeof improveResponse, typeof evaluateImproved]
      >({
        name: 'test-workflow',
        triggerSchema: z.object({ input: z.string() }),
      });

      promptEvalWorkflow
        .step(getUserInput)
        .then(promptAgent)
        .then(evaluateTone)
        .then(improveResponse)
        .then(evaluateImproved)
        .commit();

      const mastra = new Mastra({
        logger,
        workflows: { 'test-workflow': promptEvalWorkflow },
        storage,
      });

      const wf = mastra.getWorkflow('test-workflow');
      const run = wf.createRun();

      const initialResult = await run.start({ triggerData: { input: 'test' } });
      expect(initialResult.results.promptAgent.status).toBe('suspended');
      expect(promptAgentAction).toHaveBeenCalledTimes(1);
      expect(initialResult.activePaths.size).toBe(1);
      expect(initialResult.activePaths.get('promptAgent')?.status).toBe('suspended');
      expect(initialResult.activePaths.get('promptAgent')?.suspendPayload).toEqual({ testPayload: 'hello' });
      expect(initialResult.results).toEqual({
        getUserInput: { status: 'success', output: { userInput: 'test input' } },
        promptAgent: { status: 'suspended', suspendPayload: { testPayload: 'hello' } },
      });

      const newCtx = {
        userInput: 'test input for resumption',
      };

      expect(initialResult.results.promptAgent.status).toBe('suspended');
      expect(promptAgentAction).toHaveBeenCalledTimes(1);

      const firstResumeResult = await run.resume({ stepId: 'promptAgent', context: newCtx });

      if (!firstResumeResult) {
        throw new Error('Resume failed to return a result');
      }

      expect(firstResumeResult.activePaths.size).toBe(1);
      expect(firstResumeResult.activePaths.get('improveResponse')?.status).toBe('suspended');
      expect(firstResumeResult.results).toEqual({
        getUserInput: { status: 'success', output: { userInput: 'test input' } },
        promptAgent: { status: 'success', output: { modelOutput: 'test output' } },
        evaluateToneConsistency: {
          status: 'success',
          output: {
            toneScore: { score: 0.8 },
            completenessScore: { score: 0.7 },
          },
        },
        improveResponse: { status: 'suspended' },
      });

      const secondResumeResult = await run.resume({ stepId: 'improveResponse', context: newCtx });
      if (!secondResumeResult) {
        throw new Error('Resume failed to return a result');
      }

      expect(secondResumeResult.results).toEqual({
        getUserInput: { status: 'success', output: { userInput: 'test input' } },
        promptAgent: { status: 'success', output: { modelOutput: 'test output' } },
        evaluateToneConsistency: {
          status: 'success',
          output: { toneScore: { score: 0.8 }, completenessScore: { score: 0.7 } },
        },
        improveResponse: { status: 'success', output: { improvedOutput: 'improved output' } },
        evaluateImprovedResponse: {
          status: 'success',
          output: { toneScore: { score: 0.9 }, completenessScore: { score: 0.8 } },
        },
      });
    });

    it('should handle basic event based resume flow', async () => {
      const getUserInputAction = vi.fn().mockResolvedValue({ userInput: 'test input' });
      const promptAgentAction = vi
        .fn()
        .mockImplementationOnce(async () => {
          return { test: 'yes' };
        })
        .mockImplementationOnce(() => ({ modelOutput: 'test output' }));
      const getUserInput = new Step({
        id: 'getUserInput',
        execute: getUserInputAction,
        outputSchema: z.object({ userInput: z.string() }),
      });
      const promptAgent = new Step({
        id: 'promptAgent',
        execute: promptAgentAction,
        outputSchema: z.object({ modelOutput: z.string() }),
      });

      const promptEvalWorkflow = new Workflow({
        name: 'test-workflow',
        triggerSchema: z.object({ input: z.string() }),
        events: {
          testev: {
            schema: z.object({
              catName: z.string(),
            }),
          },
        },
      });

      promptEvalWorkflow.step(getUserInput).afterEvent('testev').step(promptAgent).commit();

      const mastra = new Mastra({
        logger,
        workflows: { 'test-workflow': promptEvalWorkflow },
      });

      const wf = mastra.getWorkflow('test-workflow');
      const run = wf.createRun({
        events: {
          testev: {
            schema: z.object({
              catName: z.string(),
            }),
          },
        },
      });

      const initialResult = await run.start({ triggerData: { input: 'test' } });
      expect(initialResult.activePaths.size).toBe(1);
      expect(initialResult.results).toEqual({
        getUserInput: { status: 'success', output: { userInput: 'test input' } },
        __testev_event: { status: 'suspended' },
      });
      expect(getUserInputAction).toHaveBeenCalledTimes(1);

      const firstResumeResult = await run.resumeWithEvent('testev', {
        catName: 'test input for resumption',
      });

      if (!firstResumeResult) {
        throw new Error('Resume failed to return a result');
      }

      expect(firstResumeResult.activePaths.size).toBe(1);
      expect(firstResumeResult.results).toEqual({
        getUserInput: { status: 'success', output: { userInput: 'test input' } },
        promptAgent: { status: 'success', output: { test: 'yes' } },
        __testev_event: {
          status: 'success',
          output: {
            executed: true,
            resumedEvent: {
              catName: 'test input for resumption',
            },
          },
        },
      });
    });
  });

  describe('Workflow Runs', () => {
    beforeEach(async () => {
      await storage.clearTable({ tableName: TABLE_WORKFLOW_SNAPSHOT });
    });

    it('should return empty result when mastra is not initialized', async () => {
      const workflow = new Workflow({ name: 'test' });
      const result = await workflow.getWorkflowRuns();
      expect(result).toEqual({ runs: [], total: 0 });
    });

    it('should get workflow runs from storage', async () => {
      await storage.init();

      const step1Action = vi.fn<any>().mockResolvedValue({ result: 'success1' });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success2' });

      const step1 = new Step({ id: 'step1', execute: step1Action });
      const step2 = new Step({ id: 'step2', execute: step2Action });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).then(step2).commit();

      const mastra = new Mastra({
        logger,
        storage,
        workflows: {
          'test-workflow': workflow,
        },
      });

      const testWorkflow = mastra.getWorkflow('test-workflow');

      // Create a few runs
      const run1 = await testWorkflow.createRun();
      await run1.start();

      const run2 = await testWorkflow.createRun();
      await run2.start();

      const { runs, total } = await testWorkflow.getWorkflowRuns();
      expect(total).toBe(2);
      expect(runs).toHaveLength(2);
      expect(runs.map(r => r.runId)).toEqual(expect.arrayContaining([run1.runId, run2.runId]));
      expect(runs[0]?.workflowName).toBe('test-workflow');
      expect(runs[0]?.snapshot).toBeDefined();
      expect(runs[1]?.snapshot).toBeDefined();
    });
  });

  describe('Accessing Mastra', () => {
    it('should be able to access the deprecated mastra primitives', async () => {
      let telemetry: Telemetry | undefined;
      const step1 = new Step({
        id: 'step1',
        execute: async ({ mastra }) => {
          telemetry = mastra?.telemetry;
        },
      });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).commit();

      const mastra = new Mastra({
        logger,
        workflows: { 'test-workflow': workflow },
        storage,
      });

      const wf = mastra.getWorkflow('test-workflow');

      expect(mastra?.getLogger()).toBe(logger);

      // Access new instance properties directly - should work without warning
      const run = wf.createRun();
      await run.start();

      expect(telemetry).toBeDefined();
      expect(telemetry).toBeInstanceOf(Telemetry);
    });

    it('should be able to access the new Mastra primitives', async () => {
      let telemetry: Telemetry | undefined;
      const step1 = new Step({
        id: 'step1',
        execute: async ({ mastra }) => {
          telemetry = mastra?.getTelemetry();
        },
      });

      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step1).commit();

      const mastra = new Mastra({
        logger,
        workflows: { 'test-workflow': workflow },
        storage,
      });

      const wf = mastra.getWorkflow('test-workflow');

      expect(mastra?.getLogger()).toBe(logger);

      // Access new instance properties directly - should work without warning
      const run = wf.createRun();
      run.watch(() => {});
      await run.start();

      expect(telemetry).toBeDefined();
      expect(telemetry).toBeInstanceOf(Telemetry);
    });
  });

  describe('Agent as step', () => {
    it('should be able to use an agent as a step', async () => {
      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema: z.object({
          prompt1: z.string(),
          prompt2: z.string(),
        }),
      });

      const agent = new Agent({
        name: 'test-agent-1',
        instructions: 'test agent instructions',
        model: openai('gpt-4'),
      });

      const agent2 = new Agent({
        name: 'test-agent-2',
        instructions: 'test agent instructions',
        model: openai('gpt-4'),
      });

      new Mastra({
        logger,
        workflows: { 'test-workflow': workflow },
        agents: { 'test-agent-1': agent, 'test-agent-2': agent2 },
        storage,
      });

      workflow
        .step(agent, {
          variables: {
            prompt: {
              step: 'trigger',
              path: 'prompt1',
            },
          },
        })
        .then(agent2, {
          variables: {
            prompt: {
              step: 'trigger',
              path: 'prompt2',
            },
          },
        })
        .commit();

      const run = workflow.createRun();
      const result = await run.start({
        triggerData: { prompt1: 'Capital of France, just the name', prompt2: 'Capital of UK, just the name' },
      });

      console.log(result);

      expect(result.results['test-agent-1']).toEqual({
        status: 'success',
        output: { text: 'Paris' },
      });

      expect(result.results['test-agent-2']).toEqual({
        status: 'success',
        output: { text: 'London' },
      });
    });

    it('should be able to use an agent as a .after() step', async () => {
      const execute = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const finalStep = new Step({ id: 'finalStep', execute });

      const workflow = new Workflow({
        name: 'test-workflow',
        triggerSchema: z.object({
          prompt1: z.string(),
          prompt2: z.string(),
        }),
      });

      const agent = new Agent({
        name: 'test-agent-1',
        instructions: 'test agent instructions',
        model: openai('gpt-4'),
      });

      const agent2 = new Agent({
        name: 'test-agent-2',
        instructions: 'test agent instructions',
        model: openai('gpt-4'),
      });

      new Mastra({
        logger,
        workflows: { 'test-workflow': workflow },
        agents: { 'test-agent-1': agent, 'test-agent-2': agent2 },
        storage,
      });

      workflow
        .step(agent, {
          variables: {
            prompt: {
              step: 'trigger',
              path: 'prompt1',
            },
          },
        })
        .step(agent2, {
          variables: {
            prompt: {
              step: 'trigger',
              path: 'prompt2',
            },
          },
        })
        .after([agent, agent2])
        .step(finalStep)
        .commit();

      const run = workflow.createRun();
      const result = await run.start({
        triggerData: { prompt1: 'Capital of France, just the name', prompt2: 'Capital of UK, just the name' },
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.results['finalStep']).toEqual({
        status: 'success',
        output: { result: 'success' },
      });

      expect(result.results['test-agent-1']).toEqual({
        status: 'success',
        output: { text: 'Paris' },
      });

      expect(result.results['test-agent-2']).toEqual({
        status: 'success',
        output: { text: 'London' },
      });
    });
  });

  describe('Nested workflows', () => {
    it('should be able to nest workflows', async () => {
      const start = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const startStep = new Step({
        id: 'start',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: start,
      });

      const other = vi.fn().mockImplementation(async () => {
        return { other: 26 };
      });
      const otherStep = new Step({
        id: 'other',
        description: 'Other step',
        execute: other,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        const startVal = context.getStepResult('start')?.newValue ?? 0;
        const otherVal = context.getStepResult('other')?.other ?? 0;
        return { finalValue: startVal + otherVal };
      });
      const last = vi.fn().mockImplementation(async () => {
        return { success: true };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          startValue: z.number(),
        }),
      });

      const wfA = new Workflow({ name: 'nested-workflow-a' }).step(startStep).then(otherStep).then(finalStep).commit();
      const wfB = new Workflow({ name: 'nested-workflow-b' }).step(startStep).then(finalStep).commit();
      counterWorkflow
        .step(wfA)
        .step(wfB)
        .after([wfA, wfB])
        .step(
          new Step({
            id: 'last-step',
            execute: last,
          }),
        )
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { startValue: 1 } });

      expect(start).toHaveBeenCalledTimes(2);
      expect(other).toHaveBeenCalledTimes(1);
      expect(final).toHaveBeenCalledTimes(2);
      expect(last).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results['nested-workflow-a'].output.results).toEqual({
        start: { output: { newValue: 1 }, status: 'success' },
        other: { output: { other: 26 }, status: 'success' },
        final: { output: { finalValue: 26 + 1 }, status: 'success' },
      });

      // @ts-ignore
      expect(results['nested-workflow-b'].output.results).toEqual({
        start: { output: { newValue: 1 }, status: 'success' },
        final: { output: { finalValue: 1 }, status: 'success' },
      });

      expect(results['last-step']).toEqual({
        output: { success: true },
        status: 'success',
      });
    });

    it('should be able to nest workflows with conditions', async () => {
      const start = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const startStep = new Step({
        id: 'start',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: start,
      });

      const other = vi.fn().mockImplementation(async () => {
        return { other: 26 };
      });
      const otherStep = new Step({
        id: 'other',
        description: 'Other step',
        execute: other,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        const startVal = context.getStepResult('start')?.newValue ?? 0;
        const otherVal = context.getStepResult('other')?.other ?? 0;
        return { finalValue: startVal + otherVal };
      });
      const last = vi.fn().mockImplementation(async () => {
        return { success: true };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: final,
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          startValue: z.number(),
        }),
      });

      const wfA = new Workflow({ name: 'nested-workflow-a' }).step(startStep).then(otherStep).then(finalStep).commit();
      const wfB = new Workflow({ name: 'nested-workflow-b' })
        .step(startStep)
        .if(async () => false)
        .then(otherStep)
        .else()
        .then(finalStep)
        .commit();
      counterWorkflow
        .step(wfA)
        .step(wfB)
        .after([wfA, wfB])
        .step(
          new Step({
            id: 'last-step',
            execute: last,
          }),
        )
        .commit();

      const run = counterWorkflow.createRun();
      const { results } = await run.start({ triggerData: { startValue: 1 } });

      expect(start).toHaveBeenCalledTimes(2);
      expect(other).toHaveBeenCalledTimes(1);
      expect(final).toHaveBeenCalledTimes(2);
      expect(last).toHaveBeenCalledTimes(1);
      // @ts-ignore
      expect(results['nested-workflow-a'].output.results).toEqual({
        start: { output: { newValue: 1 }, status: 'success' },
        other: { output: { other: 26 }, status: 'success' },
        final: { output: { finalValue: 26 + 1 }, status: 'success' },
      });

      // @ts-ignore
      expect(results['nested-workflow-b'].output.results).toEqual({
        start: { output: { newValue: 1 }, status: 'success' },
        final: { output: { finalValue: 1 }, status: 'success' },
        __start_else_1: {
          output: {
            executed: true,
          },
          status: 'success',
        },
        __start_if_1: {
          status: 'skipped',
        },
      });

      expect(results['last-step']).toEqual({
        output: { success: true },
        status: 'success',
      });
    });

    describe('new if else branching syntax with nested workflows', () => {
      it('should execute if-branch', async () => {
        const start = vi.fn().mockImplementation(async ({ context }) => {
          // Get the current value (either from trigger or previous increment)
          const currentValue =
            context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

          // Increment the value
          const newValue = currentValue + 1;

          return { newValue };
        });
        const startStep = new Step({
          id: 'start',
          description: 'Increments the current value by 1',
          outputSchema: z.object({
            newValue: z.number(),
          }),
          execute: start,
        });

        const other = vi.fn().mockImplementation(async () => {
          return { other: 26 };
        });
        const otherStep = new Step({
          id: 'other',
          description: 'Other step',
          execute: other,
        });

        const final = vi.fn().mockImplementation(async ({ context }) => {
          const startVal = context.getStepResult('start')?.newValue ?? 0;
          const otherVal = context.getStepResult('other')?.other ?? 0;
          return { finalValue: startVal + otherVal };
        });
        const first = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const last = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const finalStep = new Step({
          id: 'final',
          description: 'Final step that prints the result',
          execute: final,
        });

        const counterWorkflow = new Workflow({
          name: 'counter-workflow',
          triggerSchema: z.object({
            startValue: z.number(),
          }),
        });

        const wfA = new Workflow({ name: 'nested-workflow-a' })
          .step(startStep)
          .then(otherStep)
          .then(finalStep)
          .commit();
        const wfB = new Workflow({ name: 'nested-workflow-b' }).step(startStep).then(finalStep).commit();

        counterWorkflow
          .step(
            new Step({
              id: 'first-step',
              execute: first,
            }),
          )
          .if(async () => true, wfA, wfB)
          .then(
            new Step({
              id: 'last-step',
              execute: last,
            }),
          )
          .commit();

        const run = counterWorkflow.createRun();
        const { results } = await run.start({ triggerData: { startValue: 1 } });

        expect(start).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(final).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledTimes(1);
        expect(last).toHaveBeenCalledTimes(1);
        // @ts-ignore
        expect(results['nested-workflow-a'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          other: { output: { other: 26 }, status: 'success' },
          final: { output: { finalValue: 26 + 1 }, status: 'success' },
        });

        expect(results['nested-workflow-b']).toEqual({
          status: 'skipped',
        });

        expect(results['first-step']).toEqual({
          output: { success: true },
          status: 'success',
        });

        expect(results['last-step']).toEqual({
          output: { success: true },
          status: 'success',
        });
      });

      it('should execute else-branch', async () => {
        const start = vi.fn().mockImplementation(async ({ context }) => {
          // Get the current value (either from trigger or previous increment)
          const currentValue =
            context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

          // Increment the value
          const newValue = currentValue + 1;

          return { newValue };
        });
        const startStep = new Step({
          id: 'start',
          description: 'Increments the current value by 1',
          outputSchema: z.object({
            newValue: z.number(),
          }),
          execute: start,
        });

        const other = vi.fn().mockImplementation(async () => {
          return { other: 26 };
        });
        const otherStep = new Step({
          id: 'other',
          description: 'Other step',
          execute: other,
        });

        const final = vi.fn().mockImplementation(async ({ context }) => {
          const startVal = context.getStepResult('start')?.newValue ?? 0;
          const otherVal = context.getStepResult('other')?.other ?? 0;
          return { finalValue: startVal + otherVal };
        });
        const first = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const last = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const finalStep = new Step({
          id: 'final',
          description: 'Final step that prints the result',
          execute: final,
        });

        const counterWorkflow = new Workflow({
          name: 'counter-workflow',
          triggerSchema: z.object({
            startValue: z.number(),
          }),
        });

        const wfA = new Workflow({ name: 'nested-workflow-a' })
          .step(startStep)
          .then(otherStep)
          .then(finalStep)
          .commit();
        const wfB = new Workflow({ name: 'nested-workflow-b' }).step(startStep).then(finalStep).commit();

        counterWorkflow
          .step(
            new Step({
              id: 'first-step',
              execute: first,
            }),
          )
          .if(async () => false, wfA, wfB)
          .then(
            new Step({
              id: 'last-step',
              execute: last,
            }),
          )
          .commit();

        const run = counterWorkflow.createRun();
        const { results } = await run.start({ triggerData: { startValue: 1 } });

        expect(start).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(0);
        expect(final).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledTimes(1);
        expect(last).toHaveBeenCalledTimes(1);

        expect(results['nested-workflow-a']).toEqual({
          status: 'skipped',
        });

        // @ts-ignore
        expect(results['nested-workflow-b'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          final: { output: { finalValue: 1 }, status: 'success' },
        });

        expect(results['first-step']).toEqual({
          output: { success: true },
          status: 'success',
        });

        expect(results['last-step']).toEqual({
          output: { success: true },
          status: 'success',
        });
      });

      it('should execute nested else and if-branch', async () => {
        const start = vi.fn().mockImplementation(async ({ context }) => {
          // Get the current value (either from trigger or previous increment)
          const currentValue =
            context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

          // Increment the value
          const newValue = currentValue + 1;

          return { newValue };
        });
        const startStep = new Step({
          id: 'start',
          description: 'Increments the current value by 1',
          outputSchema: z.object({
            newValue: z.number(),
          }),
          execute: start,
        });

        const other = vi.fn().mockImplementation(async () => {
          return { other: 26 };
        });
        const otherStep = new Step({
          id: 'other',
          description: 'Other step',
          execute: other,
        });

        const final = vi.fn().mockImplementation(async ({ context }) => {
          const startVal = context.getStepResult('start')?.newValue ?? 0;
          const otherVal = context.getStepResult('other')?.other ?? 0;
          return { finalValue: startVal + otherVal };
        });
        const first = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const last = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const finalStep = new Step({
          id: 'final',
          description: 'Final step that prints the result',
          execute: final,
        });

        const counterWorkflow = new Workflow({
          name: 'counter-workflow',
          triggerSchema: z.object({
            startValue: z.number(),
          }),
        });

        const wfA = new Workflow({ name: 'nested-workflow-a' })
          .step(startStep)
          .then(otherStep)
          .then(finalStep)
          .commit();
        const wfB = new Workflow({ name: 'nested-workflow-b' })
          .step(startStep)
          .if(
            async () => true,
            new Workflow({ name: 'nested-workflow-c' }).step(otherStep).commit(),
            new Workflow({ name: 'nested-workflow-d' }).step(otherStep).commit(),
          )
          .then(finalStep)
          .commit();

        counterWorkflow
          .step(
            new Step({
              id: 'first-step',
              execute: first,
            }),
          )
          .if(async () => false, wfA, wfB)
          .then(
            new Step({
              id: 'last-step',
              execute: last,
            }),
          )
          .commit();

        const run = counterWorkflow.createRun();
        const { results } = await run.start({ triggerData: { startValue: 1 } });

        expect(start).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(final).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledTimes(1);
        expect(last).toHaveBeenCalledTimes(1);

        expect(results['nested-workflow-a']).toEqual({
          status: 'skipped',
        });

        // @ts-ignore
        delete results['nested-workflow-b'].output.results['nested-workflow-c'].output.runId;
        // @ts-ignore
        delete results['nested-workflow-b'].output.results['nested-workflow-c'].output.activePaths;

        // @ts-ignore
        expect(results['nested-workflow-b'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          final: { output: { finalValue: 1 }, status: 'success' },
          'nested-workflow-c': {
            output: {
              results: {
                other: {
                  output: {
                    other: 26,
                  },
                  status: 'success',
                },
              },
              timestamp: expect.any(Number),
            },
            status: 'success',
          },
          'nested-workflow-d': {
            status: 'skipped',
          },
          start_if_else: {
            output: {
              executed: true,
            },
            status: 'success',
          },
        });

        expect(results['first-step']).toEqual({
          output: { success: true },
          status: 'success',
        });

        expect(results['last-step']).toEqual({
          output: { success: true },
          status: 'success',
        });
      });
    });

    describe('new .step/.then array syntax for concurrent execution', () => {
      it('should be able to nest workflows with .step([])', async () => {
        const start = vi.fn().mockImplementation(async ({ context }) => {
          // Get the current value (either from trigger or previous increment)
          const currentValue =
            context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

          // Increment the value
          const newValue = currentValue + 1;

          return { newValue };
        });
        const startStep = new Step({
          id: 'start',
          description: 'Increments the current value by 1',
          outputSchema: z.object({
            newValue: z.number(),
          }),
          execute: start,
        });

        const other = vi.fn().mockImplementation(async () => {
          return { other: 26 };
        });
        const otherStep = new Step({
          id: 'other',
          description: 'Other step',
          execute: other,
        });

        const final = vi.fn().mockImplementation(async ({ context }) => {
          const startVal = context.getStepResult('start')?.newValue ?? 0;
          const otherVal = context.getStepResult('other')?.other ?? 0;
          return { finalValue: startVal + otherVal };
        });
        const last = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const finalStep = new Step({
          id: 'final',
          description: 'Final step that prints the result',
          execute: final,
        });

        const counterWorkflow = new Workflow({
          name: 'counter-workflow',
          triggerSchema: z.object({
            startValue: z.number(),
          }),
        });

        const wfA = new Workflow({ name: 'nested-workflow-a' })
          .step(startStep)
          .then(otherStep)
          .then(finalStep)
          .commit();
        const wfB = new Workflow({ name: 'nested-workflow-b' }).step(startStep).then(finalStep).commit();
        counterWorkflow
          .step([wfA, wfB])
          .then(
            new Step({
              id: 'last-step',
              execute: last,
            }),
          )
          .commit();

        const run = counterWorkflow.createRun();
        const { results } = await run.start({ triggerData: { startValue: 1 } });

        expect(start).toHaveBeenCalledTimes(2);
        expect(other).toHaveBeenCalledTimes(1);
        expect(final).toHaveBeenCalledTimes(2);
        expect(last).toHaveBeenCalledTimes(1);
        // @ts-ignore
        expect(results['nested-workflow-a'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          other: { output: { other: 26 }, status: 'success' },
          final: { output: { finalValue: 26 + 1 }, status: 'success' },
        });

        // @ts-ignore
        expect(results['nested-workflow-b'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          final: { output: { finalValue: 1 }, status: 'success' },
        });

        expect(results['last-step']).toEqual({
          output: { success: true },
          status: 'success',
        });
      });

      it('should be able to nest workflows with .step([]) and run more concurrent steps with .then([])', async () => {
        const start = vi.fn().mockImplementation(async ({ context }) => {
          // Get the current value (either from trigger or previous increment)
          const currentValue =
            context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

          // Increment the value
          const newValue = currentValue + 1;

          return { newValue };
        });
        const startStep = new Step({
          id: 'start',
          description: 'Increments the current value by 1',
          outputSchema: z.object({
            newValue: z.number(),
          }),
          execute: start,
        });

        const other = vi.fn().mockImplementation(async () => {
          return { other: 26 };
        });
        const otherStep = new Step({
          id: 'other',
          description: 'Other step',
          execute: other,
        });

        const final = vi.fn().mockImplementation(async ({ context }) => {
          const startVal = context.getStepResult('start')?.newValue ?? 0;
          const otherVal = context.getStepResult('other')?.other ?? 0;
          return { finalValue: startVal + otherVal };
        });
        const last = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const finalStep = new Step({
          id: 'final',
          description: 'Final step that prints the result',
          execute: final,
        });

        const counterWorkflow = new Workflow({
          name: 'counter-workflow',
          triggerSchema: z.object({
            startValue: z.number(),
          }),
        });

        const wfA = new Workflow({ name: 'nested-workflow-a' })
          .step(startStep)
          .then(otherStep)
          .then(finalStep)
          .commit();
        const wfB = new Workflow({ name: 'nested-workflow-b' }).step(startStep).then(finalStep).commit();
        counterWorkflow
          .step([wfA, wfB])
          .then([
            new Step({
              id: 'last-step',
              execute: last,
            }),
            new Step({
              id: 'last-step-2',
              execute: last,
            }),
          ])
          .then(
            new Step({
              id: 'last-step-3',
              execute: last,
            }),
          )
          .commit();

        const run = counterWorkflow.createRun();
        const { results } = await run.start({ triggerData: { startValue: 1 } });

        expect(start).toHaveBeenCalledTimes(2);
        expect(other).toHaveBeenCalledTimes(1);
        expect(final).toHaveBeenCalledTimes(2);
        expect(last).toHaveBeenCalledTimes(3);
        // @ts-ignore
        expect(results['nested-workflow-a'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          other: { output: { other: 26 }, status: 'success' },
          final: { output: { finalValue: 26 + 1 }, status: 'success' },
        });

        // @ts-ignore
        expect(results['nested-workflow-b'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          final: { output: { finalValue: 1 }, status: 'success' },
        });

        expect(results['last-step']).toEqual({
          output: { success: true },
          status: 'success',
        });

        expect(results['last-step-2']).toEqual({
          output: { success: true },
          status: 'success',
        });

        expect(results['last-step-3']).toEqual({
          output: { success: true },
          status: 'success',
        });
      });
    });

    describe('watching nested workflows', () => {
      // TODO: craft a test out of this
      it.skip('should be able to watch nested workflows with .step([])', async () => {
        const start = vi.fn().mockImplementation(async ({ context }) => {
          // Get the current value (either from trigger or previous increment)
          const currentValue =
            context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

          // Increment the value
          const newValue = currentValue + 1;

          return { newValue };
        });
        const startStep = new Step({
          id: 'start',
          description: 'Increments the current value by 1',
          outputSchema: z.object({
            newValue: z.number(),
          }),
          execute: start,
        });

        const other = vi.fn().mockImplementation(async () => {
          return { other: 26 };
        });
        const otherStep = new Step({
          id: 'other',
          description: 'Other step',
          execute: other,
        });

        const final = vi.fn().mockImplementation(async ({ context }) => {
          const startVal = context.getStepResult('start')?.newValue ?? 0;
          const otherVal = context.getStepResult('other')?.other ?? 0;
          return { finalValue: startVal + otherVal };
        });
        const last = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const finalStep = new Step({
          id: 'final',
          description: 'Final step that prints the result',
          execute: final,
        });

        const counterWorkflow = new Workflow({
          name: 'counter-workflow',
          triggerSchema: z.object({
            startValue: z.number(),
          }),
        });

        const wfA = new Workflow({ name: 'nested-workflow-a' })
          .step(startStep)
          .then(otherStep)
          .then(finalStep)
          .commit();
        const wfB = new Workflow({ name: 'nested-workflow-b' }).step(startStep).then(finalStep).commit();
        counterWorkflow
          .step([wfA, wfB])
          .then(
            new Step({
              id: 'last-step',
              execute: last,
            }),
          )
          .commit();

        const run = counterWorkflow.createRun();
        const unwatch = counterWorkflow.watch(state => {
          console.log('state', JSON.stringify(state.results, null, 2));
        });
        const { results } = await run.start({ triggerData: { startValue: 1 } });

        expect(start).toHaveBeenCalledTimes(2);
        expect(other).toHaveBeenCalledTimes(1);
        expect(final).toHaveBeenCalledTimes(2);
        expect(last).toHaveBeenCalledTimes(1);
        // @ts-ignore
        expect(results['nested-workflow-a'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          other: { output: { other: 26 }, status: 'success' },
          final: { output: { finalValue: 26 + 1 }, status: 'success' },
        });

        // @ts-ignore
        expect(results['nested-workflow-b'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          final: { output: { finalValue: 1 }, status: 'success' },
        });

        expect(results['last-step']).toEqual({
          output: { success: true },
          status: 'success',
        });

        unwatch();
      });
    });

    describe('suspending and resuming nested workflows', () => {
      it('should be able to suspend nested workflow step', async () => {
        const start = vi.fn().mockImplementation(async ({ context }) => {
          // Get the current value (either from trigger or previous increment)
          const currentValue =
            context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

          // Increment the value
          const newValue = currentValue + 1;

          return { newValue };
        });
        const startStep = new Step({
          id: 'start',
          description: 'Increments the current value by 1',
          outputSchema: z.object({
            newValue: z.number(),
          }),
          execute: start,
        });

        let wasSuspended = false;
        const other = vi.fn().mockImplementation(async ({ suspend }) => {
          if (!wasSuspended) {
            wasSuspended = true;
            await suspend();
          }
          return { other: 26 };
        });
        const otherStep = new Step({
          id: 'other',
          description: 'Other step',
          execute: other,
        });

        const final = vi.fn().mockImplementation(async ({ context }) => {
          const startVal = context.getStepResult('start')?.newValue ?? 0;
          const otherVal = context.getStepResult('other')?.other ?? 0;
          return { finalValue: startVal + otherVal };
        });
        const last = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const begin = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const finalStep = new Step({
          id: 'final',
          description: 'Final step that prints the result',
          outputSchema: z.object({
            finalValue: z.number(),
          }),
          execute: final,
        });

        const counterWorkflow = new Workflow({
          name: 'counter-workflow',
          triggerSchema: z.object({
            startValue: z.number(),
          }),
          result: {
            schema: z.object({
              finalValue: z.number(),
            }),
            mapping: {
              finalValue: {
                step: finalStep,
                path: 'finalValue',
              },
            },
          },
        });

        const wfA = new Workflow({ name: 'nested-workflow-a' })
          .step(startStep)
          .then(otherStep)
          .then(finalStep)
          .commit();
        counterWorkflow
          .step(
            new Step({
              id: 'begin-step',
              execute: begin,
            }),
          )
          .then(wfA)
          .then(
            new Step({
              id: 'last-step',
              execute: last,
            }),
          )
          .commit();

        new Mastra({
          logger,
          workflows: { counterWorkflow },
        });

        const run = counterWorkflow.createRun();
        const { results } = await run.start({ triggerData: { startValue: 1 } });

        expect(begin).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(final).toHaveBeenCalledTimes(0);
        expect(last).toHaveBeenCalledTimes(0);
        // @ts-ignore
        expect(results['nested-workflow-a']).toMatchObject({
          status: 'suspended',
        });

        // @ts-ignore
        expect(results['last-step']).toEqual(undefined);

        vi.clearAllMocks();
        const resumedResults = await run.resume({ stepId: 'nested-workflow-a', context: { startValue: 0 } });

        // @ts-ignore
        expect(resumedResults.results['nested-workflow-a'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          other: { output: { other: 26 }, status: 'success' },
          final: { output: { finalValue: 26 + 1 }, status: 'success' },
        });

        expect(start).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(final).toHaveBeenCalledTimes(1);
        expect(last).toHaveBeenCalledTimes(1);
      });

      it('should be able to suspend nested workflow specific nested step', async () => {
        const start = vi.fn().mockImplementation(async ({ context }) => {
          // Get the current value (either from trigger or previous increment)
          const currentValue =
            context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

          // Increment the value
          const newValue = currentValue + 1;

          return { newValue };
        });
        const startStep = new Step({
          id: 'start',
          description: 'Increments the current value by 1',
          outputSchema: z.object({
            newValue: z.number(),
          }),
          execute: start,
        });

        let wasSuspended = false;
        const other = vi.fn().mockImplementation(async ({ suspend }) => {
          if (!wasSuspended) {
            wasSuspended = true;
            await suspend();
          }
          return { other: 26 };
        });
        const otherStep = new Step({
          id: 'other',
          description: 'Other step',
          execute: other,
        });

        const final = vi.fn().mockImplementation(async ({ context }) => {
          const startVal = context.getStepResult('start')?.newValue ?? 0;
          const otherVal = context.getStepResult('other')?.other ?? 0;
          return { finalValue: startVal + otherVal };
        });
        const last = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const begin = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const finalStep = new Step({
          id: 'final',
          description: 'Final step that prints the result',
          outputSchema: z.object({
            finalValue: z.number(),
          }),
          execute: final,
        });

        const counterWorkflow = new Workflow({
          name: 'counter-workflow',
          triggerSchema: z.object({
            startValue: z.number(),
          }),
          result: {
            schema: z.object({
              finalValue: z.number(),
            }),
            mapping: {
              finalValue: {
                step: finalStep,
                path: 'finalValue',
              },
            },
          },
        });

        const wfA = new Workflow({ name: 'nested-workflow-a' })
          .step(startStep)
          .then(otherStep)
          .then(finalStep)
          .commit();
        counterWorkflow
          .step(
            new Step({
              id: 'begin-step',
              execute: begin,
            }),
          )
          .then(wfA)
          .then(
            new Step({
              id: 'last-step',
              execute: last,
            }),
          )
          .commit();

        new Mastra({
          logger,
          workflows: { counterWorkflow },
        });

        const run = counterWorkflow.createRun();
        const data = await run.start({ triggerData: { startValue: 1 } });
        const { results } = data;

        expect(begin).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(final).toHaveBeenCalledTimes(0);
        expect(last).toHaveBeenCalledTimes(0);

        // @ts-ignore
        expect(results['nested-workflow-a']).toMatchObject({
          status: 'suspended',
          output: {
            results: {
              other: {
                status: 'suspended',
              },
              start: {
                output: {
                  newValue: 1,
                },
                status: 'success',
              },
            },
          },
        });

        // @ts-ignore
        expect(results['last-step']).toEqual(undefined);
        // @ts-ignore
        expect(results['nested-workflow-a'].output.activePaths).toEqual(
          new Map([['other', { status: 'suspended', stepPath: ['start', 'other'] }]]),
        );

        const resumedResults = await run.resume({ stepId: 'nested-workflow-a.other', context: { startValue: 1 } });

        // @ts-ignore
        expect(resumedResults.results['nested-workflow-a'].output.results).toEqual({
          start: { output: { newValue: 1 }, status: 'success' },
          other: { output: { other: 26 }, status: 'success' },
          final: { output: { finalValue: 26 + 1 }, status: 'success' },
        });

        expect(begin).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(2);
        expect(final).toHaveBeenCalledTimes(1);
        expect(last).toHaveBeenCalledTimes(1);
      });
    });

    describe('Workflow results', () => {
      it('should be able to spec out workflow result via variables', async () => {
        const start = vi.fn().mockImplementation(async ({ context }) => {
          // Get the current value (either from trigger or previous increment)
          const currentValue =
            context.getStepResult('start')?.newValue || context.getStepResult('trigger')?.startValue || 0;

          // Increment the value
          const newValue = currentValue + 1;

          return { newValue };
        });
        const startStep = new Step({
          id: 'start',
          description: 'Increments the current value by 1',
          outputSchema: z.object({
            newValue: z.number(),
          }),
          execute: start,
        });

        const other = vi.fn().mockImplementation(async () => {
          return { other: 26 };
        });
        const otherStep = new Step({
          id: 'other',
          description: 'Other step',
          execute: other,
        });

        const final = vi.fn().mockImplementation(async ({ context }) => {
          const startVal = context.getStepResult('start')?.newValue ?? 0;
          const otherVal = context.getStepResult('other')?.other ?? 0;
          return { finalValue: startVal + otherVal };
        });
        const last = vi.fn().mockImplementation(async () => {
          return { success: true };
        });
        const finalStep = new Step({
          id: 'final',
          description: 'Final step that prints the result',
          outputSchema: z.object({
            finalValue: z.number(),
          }),
          execute: final,
        });

        const wfA = new Workflow({
          steps: [startStep, otherStep, finalStep],
          name: 'nested-workflow-a',
          result: {
            schema: z.object({
              finalValue: z.number(),
            }),
            mapping: {
              finalValue: {
                step: finalStep,
                path: 'finalValue',
              },
            },
          },
        })
          .step(startStep)
          .then(otherStep)
          .then(finalStep)
          .commit();

        const counterWorkflow = new Workflow({
          name: 'counter-workflow',
          steps: [wfA.toStep()],
          triggerSchema: z.object({
            startValue: z.number(),
          }),
          result: {
            schema: z.object({
              finalValue: z.number(),
            }),
            mapping: {
              finalValue: {
                step: wfA,
                path: 'result.finalValue',
              },
            },
          },
        });

        // const myStep = new Step({
        //   id: 'my-step',
        //   inputSchema: z.object({
        //     input: z.string(),
        //   }),
        //   outputSchema: z.object({
        //     output: z.string(),
        //   }),
        //   description: 'My step',
        //   execute: async () => {
        //     return { output: 'lolo' };
        //   },
        // });

        counterWorkflow
          .step(wfA)
          .then(
            new Step({
              id: 'last-step',
              execute: last,
            }),
          )
          .commit();

        const run = counterWorkflow.createRun();
        const result = await run.start({ triggerData: { startValue: 1 } });
        const results = result.results;
        // const x = result.results['nested-workflow-a'];
        // if (x.status === 'success') {
        //   const lastStepVal =
        //     x.output.results.final.status === 'success' ? x.output.results.final.output.finalValue : undefined;
        //   const r = x.output.result;
        // }

        expect(start).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(final).toHaveBeenCalledTimes(1);
        expect(last).toHaveBeenCalledTimes(1);

        // @ts-ignore
        expect(results['nested-workflow-a']).toMatchObject({
          status: 'success',
          output: {
            result: {
              finalValue: 26 + 1,
            },

            results: {
              start: { output: { newValue: 1 }, status: 'success' },
              other: { output: { other: 26 }, status: 'success' },
              final: { output: { finalValue: 26 + 1 }, status: 'success' },
            },
          },
        });

        expect(result.result).toEqual({
          finalValue: 26 + 1,
        });
      });
    });
  });

  describe('Unique step IDs', () => {
    it('should run compound subscribers on a loop using step id from config', async () => {
      const increment = vi.fn().mockImplementation(async ({ context }) => {
        // Get the current value (either from trigger or previous increment)
        const currentValue =
          context.getStepResult('incrementStep')?.newValue || context.getStepResult('trigger')?.startValue || 0;

        // Increment the value
        const newValue = currentValue + 1;

        return { newValue };
      });
      const incrementStep = new Step({
        id: 'increment',
        description: 'Increments the current value by 1',
        outputSchema: z.object({
          newValue: z.number(),
        }),
        execute: increment,
      });

      const final = vi.fn().mockImplementation(async ({ context }) => {
        return { finalValue: context.getStepResult('incrementStep')?.newValue };
      });
      const finalStep = new Step({
        id: 'final',
        description: 'Final step that prints the result',
        execute: async (...rest) => {
          return final(...rest);
        },
      });

      const mockAction = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const dummyStep = new Step({
        id: 'dummy',
        description: 'Dummy step',
        execute: async (...rest) => {
          return mockAction(...rest);
        },
      });

      const mockAction2 = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const dummyStep2 = new Step({
        id: 'dummy2',
        description: 'Dummy step',
        execute: async (...rest) => {
          return mockAction2(...rest);
        },
      });

      const mockAction3 = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const dummyStep3 = new Step({
        id: 'dummy3',
        description: 'Dummy step',
        execute: async (...rest) => {
          return mockAction3(...rest);
        },
      });

      const mockAction4 = vi.fn<any>().mockResolvedValue({ result: 'success' });
      const dummyStep4 = new Step({
        id: 'dummy4',
        description: 'Dummy step',
        execute: async (...rest) => {
          return mockAction4(...rest);
        },
      });

      const counterWorkflow = new Workflow({
        name: 'counter-workflow',
        triggerSchema: z.object({
          target: z.number(),
          startValue: z.number(),
        }),
      });

      counterWorkflow
        .step(incrementStep, { id: 'incrementStep' })
        .after('incrementStep')
        .step(dummyStep, { id: 'dummyStep' })
        .after('incrementStep')
        .step(dummyStep2, { id: 'dummyStep2' })
        .after(['dummyStep', 'dummyStep2'])
        .step(dummyStep3, { id: 'dummyStep3' })
        .after('dummyStep3')
        .step(incrementStep, {
          id: 'incrementStep',
          when: async ({ context }) => {
            const isPassed = context.getStepResult('incrementStep')?.newValue < 10;
            if (isPassed) {
              return true;
            } else {
              return WhenConditionReturnValue.LIMBO;
            }
          },
        })
        .step(finalStep, {
          id: 'finalStep',
          when: async ({ context }) => {
            const isPassed = context.getStepResult('incrementStep')?.newValue >= 10;
            return isPassed;
          },
        })
        .then(dummyStep4, { id: 'dummyStep4' })
        .then(dummyStep4, { id: 'dummyStep4-2' })
        .commit();

      const run = counterWorkflow.createRun();
      const result = await run.start({ triggerData: { target: 10, startValue: 0 } });
      const results = result.results;

      expect(increment).toHaveBeenCalledTimes(10);
      expect(mockAction).toHaveBeenCalledTimes(10);
      expect(mockAction2).toHaveBeenCalledTimes(10);
      expect(mockAction3).toHaveBeenCalledTimes(10);
      expect(mockAction4).toHaveBeenCalledTimes(2);
      expect(final).toHaveBeenCalledTimes(1);
      expect(results).toMatchObject(
        expect.objectContaining({
          incrementStep: { status: 'skipped' },
          dummyStep: { status: 'success', output: { result: 'success' } },
          dummyStep2: { status: 'success', output: { result: 'success' } },
          dummyStep3: { status: 'success', output: { result: 'success' } },
          finalStep: { status: 'success', output: { finalValue: undefined } },
          dummyStep4: { status: 'success', output: { result: 'success' } },
          'dummyStep4-2': { status: 'success', output: { result: 'success' } },
        }),
      );
    });

    it('should resolve variables from previous steps using step id from config', async () => {
      const step1Action = vi.fn<any>().mockResolvedValue({
        nested: { value: 'step1-data' },
      });
      const step2Action = vi.fn<any>().mockResolvedValue({ result: 'success' });

      const step1 = new Step({
        id: 'step1',
        execute: step1Action,
        outputSchema: z.object({ nested: z.object({ value: z.string() }) }),
      });
      const step2 = new Step({
        id: 'step2',
        execute: step2Action,
        inputSchema: z.object({ previousValue: z.string() }),
      });

      const workflow = new Workflow({
        name: 'test-workflow',
      });

      workflow
        .step(step1, { id: 'steppy1' })
        .then(step2, {
          id: 'steppy2',
          variables: {
            previousValue: { step: { id: 'steppy1' }, path: 'nested.value' },
          },
        })
        .commit();

      const run = workflow.createRun();
      const results = await run.start();

      const baseContext = {
        attempts: { steppy1: 0, steppy2: 0 },
        steps: {},
        triggerData: {},
        getStepResult: expect.any(Function),
      };

      expect(step2Action).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            ...baseContext,
            steps: {
              steppy1: {
                output: {
                  nested: {
                    value: 'step1-data',
                  },
                },
                status: 'success',
              },
            },
            inputData: {
              previousValue: 'step1-data',
            },
          }),
          runId: results.runId,
        }),
      );
    });
  });

  describe('Dependency Injection', () => {
    it('should inject container dependencies into steps during run', async () => {
      const container = new Container();
      const testValue = 'test-dependency';
      container.set('testKey', testValue);

      const execute = vi.fn(({ container }) => {
        const value = container.get('testKey');
        return { injectedValue: value };
      });

      const step = new Step({ id: 'step1', execute });
      const workflow = new Workflow({ name: 'test-workflow' });
      workflow.step(step).commit();

      const run = workflow.createRun();
      const result = await run.start({ container });

      expect(result.results.step1.output.injectedValue).toBe(testValue);
    });

    it('should inject container dependencies into steps during resume', async () => {
      const container = new Container();
      const testValue = 'test-dependency';
      container.set('testKey', testValue);

      const mastra = new Mastra({
        logger: false,
        storage,
      });

      const execute = vi.fn(async ({ container, suspend, context }) => {
        if (!context.inputData.human) {
          await suspend();
        }

        const value = container.get('testKey');
        return { injectedValue: value };
      });

      const step = new Step({ id: 'step1', execute });
      const workflow = new Workflow({ name: 'test-workflow', mastra });
      workflow.step(step).commit();

      const run = workflow.createRun();
      await run.start({ container });

      const resumeContainer = new Container();
      resumeContainer.set('testKey', testValue + '2');

      const result = await run.resume({
        stepId: 'step1',
        context: {
          human: true,
        },
        container: resumeContainer,
      });

      console.log(result);
      expect(result?.results.step1.output.injectedValue).toBe(testValue + '2');
    });
  });
});
