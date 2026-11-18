import { runProspectingAgent } from '../services/agents/ProspectingAgent.js';
import { runDealIntelligenceAgent } from '../services/agents/DealIntelligenceAgent.js';
import { runHexagonSummaryAgent } from '../services/agents/HexagonSummaryAgent.js';
import User from '../models/User.js';

// Agent emails may only go to the server-configured demo inbox or to the
// caller's own verified account address. Accepting any address from the request
// body turned this endpoint into an open mail relay on the owner's Resend key.
const resolveRecipient = async (req) => {
    const configured = (process.env.DEMO_RECIPIENT_EMAIL || '').trim().toLowerCase();
    const requested = typeof req.body?.demoEmail === 'string' ? req.body.demoEmail.trim().toLowerCase() : '';
    const account = await User.findById(req.user.id).select('email').lean();
    const ownEmail = (account?.email || '').toLowerCase();

    if (!requested) return { email: configured || ownEmail || null };
    if (requested === ownEmail || (configured && requested === configured)) return { email: requested };
    return { error: 'Agent emails can only be sent to your own account email address.' };
};

// The hexagon summary is public (the research map calls it without an account),
// so besides the per-IP rate limit in app.js there is one budget shared by ALL
// callers: the number of summaries the paid model is asked for per hour. It is
// taken only by requests that passed validation and are about to reach the model.
const SUMMARY_WINDOW_MS = 60 * 60 * 1000;
const summaryBudget = { windowStart: 0, used: 0 };
const takeSummaryBudget = () => {
    const configured = Number(process.env.PUBLIC_SUMMARY_HOURLY_BUDGET);
    const limit = configured > 0 ? configured : 200;
    const now = Date.now();
    if (now - summaryBudget.windowStart >= SUMMARY_WINDOW_MS) {
        summaryBudget.windowStart = now;
        summaryBudget.used = 0;
    }
    if (summaryBudget.used >= limit) return false;
    summaryBudget.used += 1;
    return true;
};
/** Test hook: starts a fresh budget window. */
export const resetSummaryBudget = () => { summaryBudget.windowStart = 0; summaryBudget.used = 0; };

export const triggerProspecting = async(req, res, next) => {
    if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: { message: "Missing GEMINI_API_KEY in .env" } });
    try {
        console.log("\n-> Executing Prospecting Agent via API...");
        const recipient = await resolveRecipient(req);
        if (recipient.error) return res.status(403).json({ success: false, error: { message: recipient.error } });
        const targetEmail = recipient.email;

        const result = await runProspectingAgent(targetEmail);
        res.json({ success: true, result });
    } catch (err) {
        next(err);
    }
};

export const triggerDealIntelligence = async (req, res, next) => {
    if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: { message: "Missing GEMINI_API_KEY in .env" } });
    try {
        console.log("\n-> Executing Deal Intelligence Agent via API...");
        const recipient = await resolveRecipient(req);
        if (recipient.error) return res.status(403).json({ success: false, error: { message: recipient.error } });
        const result = await runDealIntelligenceAgent(recipient.email);
        res.json({ success: true, result });
    } catch (err) {
        next(err);
    }
};

export const triggerHexagonSummary = async (req, res, next) => {
    if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: { message: "Missing GEMINI_API_KEY in .env" } });
    try {
        console.log("\n-> Executing Hexagon Summary Agent via API...");
        const { reviews } = req.body || {};
        if (!reviews || !Array.isArray(reviews)) {
            return res.status(400).json({ error: { message: "Invalid reviews array" } });
        }

        // Keep only well-formed entries, cap the count and the text length so the
        // endpoint cannot be used to push arbitrary large prompts to the model.
        const sampleReviews = reviews
            .filter(r => r && typeof r === 'object' && typeof r.text === 'string' && r.text.trim())
            .slice(0, 50)
            .map(r => ({
                rating: Number.isFinite(Number(r.rating)) ? Math.min(5, Math.max(0, Number(r.rating))) : 0,
                text: r.text.replace(/\s+/g, ' ').trim().slice(0, 600)
            }));
        if (sampleReviews.length === 0) {
            return res.status(400).json({ error: { message: "No valid reviews to summarize" } });
        }
        
        if (!takeSummaryBudget()) {
            return res.status(429).json({ success: false, error: { message: 'The summary service is busy, please try again later.' } });
        }

        const result = await runHexagonSummaryAgent(sampleReviews);
        res.json({ success: true, result });
    } catch (err) {
        next(err);
    }
};
