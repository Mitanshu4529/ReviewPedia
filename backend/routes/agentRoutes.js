import express from 'express';
import { triggerProspecting, triggerDealIntelligence, triggerHexagonSummary } from '../controllers/agentController.js';
import { requireAuth, requireRole } from '../middlewares/authMiddleware.js';

const router = express.Router();

// The two agents below call the AI model several times per run and send email,
// so only admin accounts may start them (grant the role with scripts/setRole.js).
// The hexagon summary stays public; it is rate limited and has an hourly budget.
router.post('/prospecting', requireAuth, requireRole('admin'), triggerProspecting);
router.post('/deal-intelligence', requireAuth, requireRole('admin'), triggerDealIntelligence);
router.post('/hexagon-summary', triggerHexagonSummary);

export default router;
