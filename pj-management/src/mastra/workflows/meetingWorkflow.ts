import { z } from 'zod';
import { Workflow, Step, StepExecutionContext, WorkflowContext } from '@mastra/core/workflows';
import { openai } from '@ai-sdk/openai';
import { embeddingModel } from '../memory/vectorStore.js';
import { saveTasks, taskSchema } from '../tools/taskTools.js';
import { db } from '../../db/index.js';

// Define the OpenAI model to use (ensure OPENAI_API_KEY is set in .env)
const llm = openai('gpt-4o'); // Or your preferred chat model

// --- Input/Output Schemas ---
const workflowInputSchema = z.object({
  projectId: z.string(),
  meetingDate: z.string().datetime({ message: '日付は ISO 8601 形式である必要があります' }),
  participants: z.array(z.string()).optional(),
  transcript: z.string(),
});

const validatedMetadataSchema = workflowInputSchema.extend({
  meetingDate: z.date(), // Convert string to Date
  participants: z.array(z.string()), // Ensure it's an array
});

const analysisSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  nextSteps: z.array(z.string()).optional(),
});

const analyzedDataSchema = validatedMetadataSchema.extend({
  analysis: analysisSchema,
});

const extractedTasksSchema = analyzedDataSchema.extend({
  tasks: z.array(taskSchema), // Use the imported taskSchema
});

const finalOutputSchema = z.object({
  status: z.literal('success'),
  meetingId: z.string(),
  projectId: z.string(),
  meetingDate: z.date(),
  summary: z.string(),
  taskCount: z.number(),
});

// Define context types for steps (adjust based on actual WorkflowContext structure if needed)
type ValidateMetadataContext = StepExecutionContext<
  typeof workflowInputSchema,
  WorkflowContext<{ triggerData: z.infer<typeof workflowInputSchema> }>
>;
type AnalyzeMeetingContext = StepExecutionContext<
  typeof validatedMetadataSchema,
  WorkflowContext<{ steps: { validateMetadata: { status: string; output: z.infer<typeof validatedMetadataSchema> } } }>
>;
type ExtractTasksContext = StepExecutionContext<
  typeof analyzedDataSchema,
  WorkflowContext<{ steps: { analyzeMeeting: { status: string; output: z.infer<typeof analyzedDataSchema> } } }>
>;
type PersistDataContext = StepExecutionContext<
  typeof extractedTasksSchema,
  WorkflowContext<{ steps: { extractTasks: { status: string; output: z.infer<typeof extractedTasksSchema> } } }>
>;

// --- Workflow Steps ---

// ステップ1: メタデータ検証
const validateMetadata = new Step({
  id: 'validateMetadata',
  inputSchema: workflowInputSchema,
  outputSchema: validatedMetadataSchema.or(
    z.object({ status: z.literal('error'), message: z.string(), missingFields: z.array(z.string()).optional() }),
  ),
  async execute(context) {
    const triggerData = context.getStepResult('trigger');
    const { transcript, projectId, meetingDate, participants } = triggerData;

    if (!transcript || !projectId || !meetingDate) {
      const missingFields = [
        !transcript ? 'transcript' : null,
        !projectId ? 'projectId' : null,
        !meetingDate ? 'meetingDate' : null,
      ].filter((field): field is string => field !== null);

      return {
        status: 'error', // Explicitly return error status
        message: '必須メタデータが不足しています',
        missingFields,
      };
    }

    try {
      const parsedDate = new Date(meetingDate);
      // Optional: Add more validation for date if needed
      return {
        projectId,
        meetingDate: parsedDate,
        participants: participants || [],
        transcript,
      };
    } catch (error) {
      return {
        status: 'error',
        message: `日付の解析に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

// ステップ2: 会議内容の分析
const analyzeMeeting = new Step({
  id: 'analyzeMeeting',
  outputSchema: analyzedDataSchema.or(
    z.object({ status: z.literal('error'), message: z.string(), rawAnalysis: z.string().optional() }),
  ),
  async execute(context) {
    const previousOutput = context.getStepResult(validateMetadata);
    if (!previousOutput || context.getStepResult(validateMetadata).status !== 'success') {
      return { status: 'error', message: 'メタデータ検証ステップが成功しませんでした' };
    }
    const { transcript, projectId, meetingDate, participants } = previousOutput;

    try {
      const analysisResult = await llm.doGenerate({
        mode: { type: 'json', schema: analysisSchema },
        prompt: [
          {
            role: 'user',
            content: `
              以下の会議トランスクリプトを分析し、以下の情報を抽出してください:
              1. 会議の要約 (300文字以内)
              2. 主要な議論ポイント (箇条書きで5-7項目)
              3. 次のステップや決定事項 (箇条書き)

              会議情報:
              プロジェクトID: ${projectId}
              日付: ${meetingDate.toISOString().split('T')[0]}
              参加者: ${participants.join(', ')}

              トランスクリプト:
              ${transcript}

              JSON形式で返答してください:
              {
                "summary": "会議の要約",
                "keyPoints": ["ポイント1", "ポイント2", ...],
                "nextSteps": ["ステップ1", "ステップ2", ...]
              }
            `,
          },
        ],
      });

      const parsedAnalysis = analysisResult.object;
      if (!parsedAnalysis) {
        throw new Error('LLM did not return a valid JSON object.');
      }

      return {
        ...previousOutput,
        analysis: parsedAnalysis,
      };
    } catch (error) {
      console.error('会議分析ステップでエラーが発生しました:', error);
      return {
        status: 'error',
        message: `会議分析に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

// ステップ3: タスク抽出
const extractTasks = new Step({
  id: 'extractTasks',
  outputSchema: extractedTasksSchema.or(
    z.object({ status: z.literal('error'), message: z.string(), rawTaskExtraction: z.string().optional() }),
  ),
  async execute(context) {
    const previousOutput = context.getStepResult(analyzeMeeting);
    if (!previousOutput || context.getStepResult(analyzeMeeting).status !== 'success') {
      return { status: 'error', message: '会議分析ステップが成功しませんでした' };
    }
    const { transcript, projectId, meetingDate, analysis } = previousOutput;
    const meetingId = `meeting-${projectId}-${meetingDate.getTime()}`; // Use consistent meetingId

    const taskExtractionSchema = z.object({
      tasks: z.array(
        z.object({
          description: z.string(),
          assignee: z.string().optional().describe('担当者名 (不明な場合はnull)').nullable(),
          dueDate: z.string().optional().describe('期限 (YYYY-MM-DD形式, 不明な場合はnull)').nullable(),
          priority: z
            .enum(['low', 'medium', 'high'])
            .default('medium')
            .optional()
            .describe('優先度 (不明な場合はmedium)'),
        }),
      ),
    });

    try {
      const taskExtractionResult = await llm.doGenerate({
        mode: { type: 'json', schema: taskExtractionSchema },
        prompt: [
          {
            role: 'user',
            content: `
              以下の会議トランスクリプトから、全てのタスクやアクションアイテムを抽出してください。
              各タスクには以下の情報を含めてください:
              - タスクの説明
              - 担当者 (言及されている場合)
              - 期限 (言及されている場合, YYYY-MM-DD形式)
              - 優先度 (言及されている場合、または内容から推測: low, medium, high)

              会議トランスクリプト:
              ${transcript}

              JSON形式で返答してください:
              {
                "tasks": [
                  {
                    "description": "タスクの説明",
                    "assignee": "担当者名 or null",
                    "dueDate": "YYYY-MM-DD or null",
                    "priority": "high/medium/low"
                  },
                  ...
                ]
              }
            `,
          },
        ],
      });

      const extractedTasksData = taskExtractionResult.object?.tasks.map(task => ({
        project_id: projectId,
        description: task.description,
        assignee: task.assignee || null,
        due_date: task.dueDate ? new Date(task.dueDate) : null, // Convert string to Date
        status: 'pending' as const,
        priority: task.priority || ('medium' as const),
        source_type: 'meeting',
        source_id: meetingId,
      }));

      if (!extractedTasksData) {
        throw new Error('LLM did not return valid task data.');
      }

      // Save extracted tasks using the helper function
      const savedTasks = await saveTasks(extractedTasksData);

      return {
        ...previousOutput,
        tasks: savedTasks, // Return the tasks saved in the DB (with IDs etc.)
      };
    } catch (error) {
      console.error('タスク抽出ステップでエラーが発生しました:', error);
      return {
        status: 'error',
        message: `タスク抽出または保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

// ステップ4: データ永続化
const persistData = new Step({
  id: 'persistData',
  outputSchema: finalOutputSchema.or(z.object({ status: z.literal('error'), message: z.string() })),
  async execute(context) {
    const previousOutput = context.getStepResult(extractTasks);
    if (!previousOutput || context.getStepResult(extractTasks).status !== 'success') {
      return { status: 'error', message: 'タスク抽出ステップが成功しませんでした' };
    }
    const { transcript, projectId, meetingDate, participants, analysis, tasks } = previousOutput;
    const meetingId = `meeting-${projectId}-${meetingDate.getTime()}`; // Consistent meetingId

    // --- Prepare data for embedding and DB insertion ---
    const documentsToEmbed: { id: string; text: string; metadata: Record<string, any> }[] = [];

    // 1. Raw Transcript
    documentsToEmbed.push({
      id: `${meetingId}-raw`,
      text: transcript,
      metadata: { type: 'meeting-transcript', projectId, meetingDate: meetingDate.toISOString(), participants },
    });

    // 2. Summary
    documentsToEmbed.push({
      id: `${meetingId}-summary`,
      text: analysis.summary,
      metadata: { type: 'meeting-summary', projectId, meetingDate: meetingDate.toISOString(), participants },
    });

    // 3. Key Points
    analysis.keyPoints.forEach((point, index) => {
      documentsToEmbed.push({
        id: `${meetingId}-keypoint-${index}`,
        text: point,
        metadata: { type: 'meeting-keypoint', projectId, meetingDate: meetingDate.toISOString(), participants },
      });
    });

    // 4. Next Steps
    (analysis.nextSteps || []).forEach((step, index) => {
      documentsToEmbed.push({
        id: `${meetingId}-nextstep-${index}`,
        text: step,
        metadata: { type: 'meeting-nextstep', projectId, meetingDate: meetingDate.toISOString(), participants },
      });
    });

    try {
      // --- Embed and Insert into Vector Store ---
      console.log(`Generating embeddings for ${documentsToEmbed.length} documents...`);
      const embeddingResults = await embeddingModel.doEmbed({ values: documentsToEmbed.map(doc => doc.text) });
      const embeddings = embeddingResults.embeddings;

      if (!embeddings || embeddings.length !== documentsToEmbed.length) {
        throw new Error('Embedding generation failed or count mismatch');
      }

      console.log(`Inserting ${embeddings.length} embeddings into database...`);
      // Use pg-promise transaction for atomicity
      await db.tx(async t => {
        const embeddingQueries = [];
        for (let i = 0; i < documentsToEmbed.length; i++) {
          const doc = documentsToEmbed[i];
          const embedding = embeddings[i];
          embeddingQueries.push(
            t.none('INSERT INTO embeddings (id, embedding, content, metadata) VALUES ($1, $2, $3, $4)', [
              doc.id,
              embedding,
              doc.text,
              doc.metadata,
            ]),
          );
        }
        await t.batch(embeddingQueries);
        console.log('Embeddings inserted successfully.');

        // --- Insert into meeting_records table ---
        console.log('Inserting meeting record...');
        await t.none(
          'INSERT INTO meeting_records (id, project_id, date, participants, raw_transcript, summary, key_points, next_steps) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            meetingId,
            projectId,
            meetingDate,
            participants,
            transcript,
            analysis.summary,
            analysis.keyPoints,
            analysis.nextSteps || [],
          ],
        );
        console.log('Meeting record inserted successfully.');
      });

      return {
        status: 'success',
        meetingId,
        projectId,
        meetingDate,
        summary: analysis.summary,
        taskCount: tasks.length,
      };
    } catch (error) {
      console.error('データ永続化ステップでエラーが発生しました:', error);
      return {
        status: 'error',
        message: `データ永続化に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

// --- Workflow Definition ---
export const meetingWorkflow = new Workflow({
  id: 'meeting-processing',
  description: '会議トランスクリプトの処理と情報抽出を行うワークフロー',
  inputSchema: workflowInputSchema,
  outputSchema: finalOutputSchema.or(z.object({ status: z.literal('error'), message: z.string() })),
})
  .step(validateMetadata)
  .then(analyzeMeeting)
  .then(extractTasks)
  .then(persistData);

// IMPORTANT: Commit the workflow definition
meetingWorkflow.commit();
