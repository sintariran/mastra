import express, { Request, Response } from 'express';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { embeddingModel } from '../mastra/memory/vectorStore.js';
import { saveTasks, taskSchema } from '../mastra/tools/taskTools.js';
import { db } from '../db/index.js';

const router = express.Router();

// Define the OpenAI model to use (ensure OPENAI_API_KEY is set in .env)
const llm = openai('gpt-4o'); // Or your preferred chat model

// --- Input Schema for /process endpoint ---
const processMeetingInputSchema = z.object({
  projectId: z.string(),
  meetingDate: z.string().datetime({ message: '日付は ISO 8601 形式である必要があります' }),
  participants: z.array(z.string()).optional(),
  transcript: z.string(),
});

// --- Schemas for LLM outputs ---
const analysisSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  nextSteps: z.array(z.string()).optional(),
});

const taskExtractionSchema = z.object({
  tasks: z.array(
    z.object({
      description: z.string(),
      assignee: z.string().optional().nullable(),
      dueDate: z.string().optional().nullable(), // Expect YYYY-MM-DD from LLM initially
      priority: z.enum(['low', 'medium', 'high']).default('medium').optional(),
    }),
  ),
});

// --- POST /api/meeting/process Endpoint ---
router.post('/process', async (req: Request, res: Response) => {
  try {
    // 1. Validate Input
    const validationResult = processMeetingInputSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({ error: 'Invalid input', details: validationResult.error.errors });
    }
    const { projectId, meetingDate: meetingDateStr, participants = [], transcript } = validationResult.data;
    const meetingDate = new Date(meetingDateStr);
    const meetingId = `meeting-${projectId}-${meetingDate.getTime()}`; // Generate consistent ID

    // 2. Analyze Meeting Content (LLM Call 1)
    console.log('Analyzing meeting content...');
    const analysisResult = await llm.doGenerate({
      inputFormat: 'messages',
      mode: { type: 'object-json', schema: analysisSchema },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `
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
        },
      ],
    });

    // Access result via text and parse JSON
    if (!analysisResult.text) {
      throw new Error('LLM analysis did not return text output.');
    }
    const analysis = analysisSchema.parse(JSON.parse(analysisResult.text));
    console.log('Meeting analysis completed.');

    // 3. Extract Tasks (LLM Call 2)
    console.log('Extracting tasks...');
    const taskExtractionResult = await llm.doGenerate({
      inputFormat: 'messages',
      mode: { type: 'object-json', schema: taskExtractionSchema },
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `
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
        },
      ],
    });

    if (!taskExtractionResult.text) {
      throw new Error('LLM task extraction did not return text output.');
    }
    const extractedTasks = taskExtractionSchema.parse(JSON.parse(taskExtractionResult.text)).tasks;
    console.log(`Extracted ${extractedTasks.length} tasks.`);

    // 4. Prepare Data for DB and Embedding
    const tasksToSave = extractedTasks.map(task => ({
      project_id: projectId,
      description: task.description,
      assignee: task.assignee || null,
      due_date: task.dueDate ? new Date(task.dueDate) : null,
      status: 'pending' as const,
      priority: task.priority || ('medium' as const),
      source_type: 'meeting',
      source_id: meetingId,
    }));

    const documentsToEmbed: { id: string; text: string; metadata: Record<string, any> }[] = [
      {
        id: `${meetingId}-raw`,
        text: transcript,
        metadata: { type: 'meeting-transcript', projectId, meetingDate: meetingDate.toISOString(), participants },
      },
      {
        id: `${meetingId}-summary`,
        text: analysis.summary,
        metadata: { type: 'meeting-summary', projectId, meetingDate: meetingDate.toISOString(), participants },
      },
      ...analysis.keyPoints.map((point, index) => ({
        id: `${meetingId}-keypoint-${index}`,
        text: point,
        metadata: { type: 'meeting-keypoint', projectId, meetingDate: meetingDate.toISOString(), participants },
      })),
      ...(analysis.nextSteps || []).map((step, index) => ({
        id: `${meetingId}-nextstep-${index}`,
        text: step,
        metadata: { type: 'meeting-nextstep', projectId, meetingDate: meetingDate.toISOString(), participants },
      })),
    ];

    // 5. Generate Embeddings
    console.log(`Generating embeddings for ${documentsToEmbed.length} documents...`);
    const embeddingResults = await embeddingModel.doEmbed({ values: documentsToEmbed.map(doc => doc.text) });
    const embeddings = embeddingResults.embeddings;
    if (!embeddings || embeddings.length !== documentsToEmbed.length) {
      throw new Error('Embedding generation failed or count mismatch');
    }
    console.log('Embeddings generated.');

    // 6. Save everything in a Transaction
    await db.tx(async t => {
      // Save tasks first (using the helper function within the transaction context if possible, or manually)
      const savedTasks = await saveTasks(tasksToSave); // Assuming saveTasks can use the transaction `t` if needed, or runs independently
      console.log(`${savedTasks.length} tasks saved.`);

      // Save embeddings
      const embeddingQueries = [];
      for (let i = 0; i < documentsToEmbed.length; i++) {
        const doc = documentsToEmbed[i];
        const embedding = embeddings[i];
        embeddingQueries.push(
          t.none(
            'INSERT INTO embeddings (id, embedding, content, metadata) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content, metadata = EXCLUDED.metadata', // Added ON CONFLICT
            [doc.id, JSON.stringify(embedding), doc.text, doc.metadata],
          ),
        );
      }
      await t.batch(embeddingQueries);
      console.log('Embeddings saved.');

      // Save meeting record
      await t.none(
        'INSERT INTO meeting_records (id, project_id, date, participants, raw_transcript, summary, key_points, next_steps) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO UPDATE SET raw_transcript = EXCLUDED.raw_transcript, summary = EXCLUDED.summary, key_points = EXCLUDED.key_points, next_steps = EXCLUDED.next_steps', // Added ON CONFLICT
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
      console.log('Meeting record saved.');
    });

    // 7. Return Success Response
    res.status(200).json({
      message: 'Meeting processed successfully',
      meetingId,
      projectId,
      summary: analysis.summary,
      tasksCreated: tasksToSave.length,
    });
  } catch (error) {
    console.error('Error processing meeting:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    // Provide more context if it's a Zod parse error from LLM output
    if (error instanceof z.ZodError) {
      return res.status(500).json({ error: 'Failed to process LLM output', details: error.errors });
    }
    res.status(500).json({ error: 'Failed to process meeting', message });
  }
});

export default router;
