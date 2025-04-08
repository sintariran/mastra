import express from 'express';
import meetingRouter from './meeting.js'; // Import with .js extension
import projectRouter from './project.js'; // Import with .js extension
// import agentRouter from './agent.js'; // エージェント用のAPIが必要な場合

const router = express.Router();

router.use('/meeting', meetingRouter);
router.use('/project', projectRouter);
// router.use('/agent', agentRouter);

// Simple health check
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

export default router;
