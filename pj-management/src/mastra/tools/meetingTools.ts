import { z } from 'zod';
import { createTool } from '@mastra/core';
import { db } from '../../db/index.js';
import { projectTools } from './projectTools.js';
import { taskTools } from './taskTools.js';
import { createOpenAI } from '@ai-sdk/openai';
import { env } from '../../utils/env.js';

// Simple helper to pick first project by name keyword (placeholder)
async function guessProjectIdByTranscript(transcript: string): Promise<string | undefined> {
  const projects = await db.manyOrNone('SELECT id, name FROM projects');
  const match = projects.find((p: { id: string; name: string }) =>
    transcript.toLowerCase().includes(p.name.toLowerCase()),
  );
  return match ? match.id : undefined;
}

export const processMeetingTranscript = createTool({
  id: 'processMeetingTranscript',
  description:
    '会議の文字起こしを解析し、要約・決定事項・アクションアイテムを抽出して保存し、必要に応じてタスクを自動生成します。',
  inputSchema: z.object({
    transcript: z.string().describe('会議の文字起こし全文'),
    projectId: z.string().optional().describe('関連プロジェクトID (不明な場合は省略可)'),
  }),
  outputSchema: z.object({
    meetingId: z.string(),
    createdTaskIds: z.array(z.string()),
  }),
  execute: async ({ context }) => {
    // 1. プロジェクト特定
    let projectId = context.projectId;
    if (!projectId) {
      projectId = await guessProjectIdByTranscript(context.transcript);
      if (!projectId) {
        throw new Error(
          'プロジェクトを特定できませんでした。transcript にプロジェクト名を含めるか、projectId を指定してください。',
        );
      }
    }

    // 2. LLM で要約・アクション抽出
    const prompt =
      `以下は会議の文字起こしです。\n---\n${context.transcript}\n---\n` +
      'この会議の要約(300文字以内)、主な決定事項(箇条書き)、次に行うべきアクションアイテム(担当者名とタイトル)をJSONで出力してください。フォーマット:\n' +
      '{"summary":"...","decisions":["..."],"actionItems":[{"title":"...","assignee":"..."}]}';
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    const model = openai('gpt-4o');

    const llmRes = await model.doGenerate({
      inputFormat: 'messages',
      mode: { type: 'regular' },
      prompt: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      ],
    });

    const parsed = JSON.parse(typeof (llmRes as any).text === 'string' ? (llmRes as any).text : '{}');

    // 3. meetings テーブルに保存
    const meeting = await db.one(
      `INSERT INTO meetings(project_id, transcript, summary, decisions, action_items)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [projectId, context.transcript, parsed.summary, parsed.decisions, parsed.actionItems],
    );

    // 4. アクションアイテムからタスク作成
    const createdTaskIds: string[] = [];
    if (Array.isArray(parsed.actionItems)) {
      for (const item of parsed.actionItems) {
        try {
          const createTaskTool = taskTools.find(t => t.id === 'createTask');
          if (createTaskTool?.execute) {
            const res: any = await createTaskTool.execute({
              context: {
                projectId,
                description: item.title,
                assignee: item.assignee,
              },
            } as any);
            if (res && typeof res.id === 'string') {
              createdTaskIds.push(res.id);
            }
          }
        } catch {
          // ignore individual task failures
        }
      }
    }

    return { meetingId: meeting.id, createdTaskIds };
  },
});
