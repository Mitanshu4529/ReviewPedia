import { GoogleGenerativeAI } from '@google/generative-ai';
import { toolsDeclarations, toolsMap } from './tools.js';
import B2BClient from '../../models/B2BClient.js';
import Review from '../../models/Review.js';
import { escapeRegex } from '../../utils/security.js';

const MAX_CLIENTS_PER_RUN = 5;
const MAX_TOOL_ROUNDS = 6;
const ALLOWED_TOOLS = new Set(toolsDeclarations.dealIntelligence.map(t => t.name));

export async function runDealIntelligenceAgent(demoEmail) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const clients = await B2BClient.find().limit(MAX_CLIENTS_PER_RUN);
    const results = [];

    for (const client of clients) {
        let trigger = null;

        // A client that has never logged in counts as inactive rather than crashing the run.
        const lastLoginMs = client.lastLogin instanceof Date ? client.lastLogin.getTime() : 0;
        const daysSinceLogin = (Date.now() - lastLoginMs) / (1000 * 60 * 60 * 24);
        if (daysSinceLogin >= 7) {
             trigger = "Inactive 7+ days";
        }

        const recentNegativesCount = await Review.countDocuments({
            "product.name": { $regex: new RegExp(escapeRegex(client.companyName), 'i') },
            "analytics.sentimentScore": { $lt: 0.5 }
        });

        // Drop to just 5 negatives to guarantee trigger
        if (recentNegativesCount >= 5) {
            trigger = "Urgent Negative Spike";
        }

        if (!trigger && daysSinceLogin < 7) {
             // If completely missing, force a generic Demo Trigger
             trigger = "Demo Trigger Active";
        }
        
        if (!trigger && daysSinceLogin >= 7) trigger = "Inactive 7+ days";

        console.log(`\n=== Deal Intelligence Agent TRIGGERED for client: ${client.companyName} [${trigger}] ===`);

        try {
            const model = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                systemInstruction: `You are the Deal Intelligence Agent for Reviewpedia.
A B2B client has not logged in recently or has a severe sentiment spike. Your job is to find the most
interesting and actionable insight about their products on the platform
since their last login, and send them a concise intelligence briefing
that makes them want to log back in immediately.

Follow this process in order:
1. Call get_full_client_context using client_id to instantly fetch all unseen reviews, sentiment spikes, and demand signals in one payload.
2. Compose a SHORT intelligence briefing (under 150 words).
3. Call send_reengagement_report with the composed briefing.

Briefing structure:
- Opening line: exactly what happened since they last logged in (numbers only).
- Highlight 1: the most important negative signal (if any) with city context.
- Highlight 2: the most positive demand signal.
- Closing: a single link to log into their dashboard to see full details.

Rules:
- Never invent data. Only use facts returned by the tools.
- If there is a sentiment spike, lead with that — it is urgent.
- Do not use marketing language. Be direct and data-first.
- Always include specific numbers, cities, and product names.`,
                tools: [{ functionDeclarations: toolsDeclarations.dealIntelligence }]
            });

            const chat = model.startChat({});
            let response = await chat.sendMessage(`Evaluate client_id: '${client.client_id}' triggered by: '${trigger}'`);

            let rounds = 0;
            while (response.response.functionCalls && response.response.functionCalls()?.length > 0) {
                // Each round is a paid model call: a model that keeps asking for tools is stopped.
                if (++rounds > MAX_TOOL_ROUNDS) {
                    throw new Error(`Agent exceeded ${MAX_TOOL_ROUNDS} tool rounds`);
                }
                const parts = [];
                for (const call of response.response.functionCalls()) {
                    try {
                        console.log(`[Agent Tool Call] ${call.name}`);

                        // Only this agent's own tools may run (not e.g. send_outreach_email).
                        if (!ALLOWED_TOOLS.has(call.name)) {
                            throw new Error(`Unknown tool: ${call.name}`);
                        }
                        if (call.name === 'send_reengagement_report') {
                            // Mail only ever goes to the approved recipient, never to an
                            // address the model chose; without one, nothing is sent.
                            if (!demoEmail) {
                                throw new Error('No approved recipient configured; email was not sent.');
                            }
                            call.args = { ...(call.args || {}), to_email: demoEmail };
                        }

                        const rawResult = await toolsMap[call.name](call.args);
                        const safeResult = (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)) ? rawResult : { output: rawResult };
                        parts.push({
                            functionResponse: {
                                name: call.name,
                                response: safeResult
                            }
                        });
                    } catch (e) {
                         parts.push({
                            functionResponse: {
                                name: call.name,
                                response: { error: e.message }
                            }
                        });
                    }
                }
                response = await chat.sendMessage(parts);
            }
            results.push({ client: client.companyName, trigger, status: "Evaluated", finalResponse: response.response.text() });
        } catch (e) {
             console.error("Agent execution failed for", client.companyName, e.message);
             results.push({ client: client.companyName, status: "Failed", finalResponse: `LLM API Error: ${e.message}` });
        }
    }
    return results;
}
