<div align="center">

<br/>

```
██████╗ ███████╗██╗   ██╗██╗███████╗██╗    ██╗██████╗ ███████╗██████╗ ██╗ █████╗
 ██╔══██╗██╔════╝██║   ██║██║██╔════╝██║    ██║██╔══██╗██╔════╝██╔══██╗██║██╔══██╗
 ██████╔╝█████╗  ██║   ██║██║█████╗  ██║ █╗ ██║██████╔╝█████╗  ██║  ██║██║███████║
 ██╔══██╗██╔══╝  ╚██╗ ██╔╝██║██╔══╝  ██║███╗██║██╔═══╝ ██╔══╝  ██║  ██║██║██╔══██║
 ██║  ██║███████╗ ╚████╔╝ ██║███████╗╚███╔███╔╝██║     ███████╗██████╔╝██║██║  ██║
 ╚═╝  ╚═╝╚══════╝  ╚═══╝  ╚═╝╚══════╝ ╚══╝╚══╝ ╚═╝     ╚══════╝╚═════╝ ╚═╝╚═╝  ╚═╝
```

**A hyperlocal, geo-indexed product review platform with an AI-powered B2B Sales Agent.**

<br/>

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose-47A248?style=flat-square&logo=mongodb&logoColor=white)](https://mongoosejs.com)
[![Gemini](https://img.shields.io/badge/Gemini-2.5%20Flash-4285F4?style=flat-square&logo=google&logoColor=white)](https://ai.google.dev)
[![H3](https://img.shields.io/badge/Uber%20H3-Geo%20Indexing-FF3F00?style=flat-square)](https://h3geo.org)
[![License](https://img.shields.io/badge/License-MIT-blueviolet?style=flat-square)](LICENSE)

<br/>

> *"What if instead of trusting a faceless 4.2★ on Amazon, you could see who in your neighbourhood actually bought it — and go meet them in the park to try it out?"*

<br/>

</div>

---

## The Problem

Every review platform today has the same core flaw: **they are not local.**

- A glowing review from Delhi tells you nothing about quality from a supplier in Bengaluru
- Amazon and Flipkart ratings are routinely gamed with paid and fake reviews
- You cannot talk to, meet, or verify the person who left the review
- There is no single place showing a product's aggregated rating across all platforms
- New, legitimate businesses look sketchy just because nobody has heard of them

**Reviewpedia fixes all of this.**

---

## What It Does

Reviewpedia is a **product review social network** built around proximity and trust. Think of it as OLX meets Google Maps meets a verified review system.

**For Consumers:**
- Post a review pinned to your exact location (using your device GPS)
- Browse a live map showing reviews of any product posted by people near you
- See review dates, photos, purchase platform, and reviewer trust scores
- Chat with reviewers, share contact info, and arrange to physically meet nearby to inspect the product in person
- After a meetup, rate the reviewer themselves — creating a human trust layer no algorithm can fake

**For Businesses (B2B Intelligence):**
- Switch to **Market Research mode** to see Uber H3 hexagonal density maps of where reviews are concentrated
- Access demand signal data: how many people clicked "I am interested" on your products, and where
- Trigger **autonomous AI Sales Agents** that research your product's review data and send personalized intelligence briefings

---

## The AI Sales Agent System

> *Built for ET AI Hackathon 2026 — Problem Statement 4: AI for Intelligent Sales & Revenue Operations*

This is the centrepiece of the hackathon submission. The platform's geo-indexed review data powers a **multi-agent B2B sales pipeline** that runs entirely autonomously.

### How It Works

```
┌─────────────────────────────────────────────────┐
│              ORCHESTRATOR                        │
│    Scans MongoDB → Builds work queue → Routes    │
└──────────────┬──────────────────────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌─────────────┐  ┌──────────────────────┐
│ PROSPECTING │  │  DEAL INTELLIGENCE   │
│    AGENT    │  │       AGENT          │
│             │  │                      │
│ Finds brands│  │ Monitors existing    │
│ with 50+    │  │ B2B clients for      │
│ reviews but │  │ inactivity & review  │
│ no contract │  │ spikes, re-engages   │
│             │  │ them automatically   │
└──────┬──────┘  └──────────┬───────────┘
       │                    │
       └──────────┬─────────┘
                  ▼
         ┌────────────────┐
         │   TOOL LAYER   │
         │                │
         │ • MongoDB Query │
         │ • H3 Geo Stats │
         │ • Resend Email │
         │ • Audit Logger │
         └────────────────┘
```

### Agent 1 — Prospecting Agent

Scans the review database for brands with significant review volume who are **not yet B2B clients**. For each qualifying brand, the agent:

1. Fetches real review statistics: city breakdown, average rating, top complaint keywords, demand signal count
2. Searches for the brand's contact information
3. Composes a hyper-personalized outreach email using only real platform data
4. Sends the email via Resend API and logs the action

**Example output subject line:**
> *"boAt has 87 reviews in Pune — here is what your customers are saying"*

### Agent 2 — Deal Intelligence Agent

Monitors existing B2B clients for churn signals. Triggers when:
- A client hasn't logged into their dashboard in **7+ days**
- A product receives a **spike of negative reviews** in a 48-hour window

The agent pulls unseen review data, identifies the most urgent signal, and sends a data-driven re-engagement briefing automatically.

**Example trigger:**
> *Client "Noise" — inactive 9 days, 8 new negative reviews in Bengaluru mentioning "strap breaking after 2 weeks" → auto-report generated and sent*

### Why This Works

The emails aren't generic cold outreach — they contain **intelligence the recipient cannot get anywhere else**: their own product's hyperlocal review data, geographic concentration of customers, and specific complaint themes from real verified buyers. That's the pitch.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **Frontend** | React 18 + Vite | Fast, component-based UI |
| **Map** | Leaflet + OpenStreetMap | Open-source, no API cost |
| **Geo-indexing** | Uber H3 (`h3-js`) | Hexagonal grid for efficient spatial queries |
| **Backend** | Node.js + Express | Matches frontend language (JS throughout) |
| **Database** | MongoDB via Mongoose | Flexible schema, fast geo queries with H3 keys |
| **Testing** | Vitest + Supertest | API integration tests against a dedicated local test database |
| **AI / LLM** | Google Gemini 2.5 Flash | Fast function calling, cost-efficient |
| **Email** | Resend API | Clean REST API, generous free tier |
| **Styling** | Custom CSS (Glassmorphism) | Lightweight, no framework dependency |

---

## Project Structure

```
Reviewpedia/
├── backend/
│   ├── controllers/              # Route controllers (auth, review, chat, agents)
│   ├── db/                       # MongoDB database connection logic
│   ├── middlewares/              # Auth, error handling, Cloudinary upload filters
│   ├── models/                   # Mongoose schemas (User, Review, Comment, Conversation, Message, etc.)
│   ├── routes/                   # Express routers (/api/auth, /api/reviews, /api/agents, /api/chat)
│   ├── services/                 # Domain logic & AI agent implementations (Gemini 2.5 Flash)
│   │   └── agents/               # ProspectingAgent, DealIntelligenceAgent, HexagonSummaryAgent
│   ├── utils/                    # JWT configuration, SSRF-safe metadata fetcher
│   ├── tests/                    # Vitest API integration test suite
│   ├── app.js                    # Express app configuration & middleware pipeline
│   ├── server.js                 # HTTP & Socket.io server bootstrap with graceful shutdown
│   └── .env.example              # Backend environment variable template
├── frontend/
│   ├── public/                   # Static assets & category graphics
│   ├── src/
│   │   ├── components/           # Map (Leaflet + H3), AgentBox, ReviewCard, ChatApp, AuthModal, etc.
│   │   ├── context/              # AuthContext & ChatContext providers
│   │   ├── utils/                # Date formatting, URL helpers, category constants
│   │   ├── App.jsx               # Application root & mode switching
│   │   └── index.css             # Glassmorphism styling tokens & responsive CSS
│   ├── index.html                # Entry HTML with web fonts
│   ├── vite.config.js            # Vite configuration with optimized vendor chunking
│   └── .env.example              # Frontend environment variable template
├── final_cleaned_reviews.csv     # Hyperlocal review dataset for initial seeding
├── DESIGN.md                     # UI/UX design specifications
└── INSTRUCTIONS.md               # Backend architecture guidelines
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- MongoDB instance (local or MongoDB Atlas)
- Google Gemini API key ([get one here](https://ai.google.dev))
- Resend API key ([optional for real emails](https://resend.com))
- Cloudinary credentials ([optional for media uploads](https://cloudinary.com))

### Installation & Local Setup

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/reviewpedia.git
cd reviewpedia

# 2. Setup and run Backend
cd backend
cp .env.example .env
# Fill in your GEMINI_API_KEY, JWT_SECRET, and MONGODB_URI in .env
npm install
npm run dev

# 3. Setup and run Frontend (in a new terminal window)
cd ../frontend
cp .env.example .env
npm install
npm run dev
```

- Frontend client runs at `http://localhost:5173`
- Backend API server runs on `http://localhost:3001` (with `/api/health` diagnostic endpoint)

---

## API Reference

| Method | Endpoint | Description | Auth Required |
|---|---|---|:---:|
| `GET` | `/api/health` | System health check, uptime, and database connection state | No |
| `POST` | `/api/auth/register` | Register new user account | No |
| `POST` | `/api/auth/login` | Login user and issue JWT cookie/token | No |
| `POST` | `/api/auth/send-signup-otp` | Send the sign-up verification code by email (Resend) | No |
| `POST` | `/api/auth/send-forgot-password-otp` | Send a password-reset code | No |
| `POST` | `/api/auth/send-email-update-otp` | Send a code to confirm a new email address | Yes |
| `POST` | `/api/auth/reset-password` | Reset password using verified email | No |
| `GET` | `/api/auth/me` | Fetch authenticated user profile | Yes |
| `GET` | `/api/reviews` | Fetch reviews with optional `?search=` and `?category=`. Paginated with `?limit=` (max 100) and `?cursor=`: returns `{ reviews, total, limit, nextCursor }`. Further filters: `?h3Index=` (one map marker), `?cell=` (one hexagon), `?userId=` (one author). Without `limit`/`cursor` it returns the legacy plain array (newest 500). | No |
| `GET` | `/api/reviews/map-stats` | Map statistics over every matching review (same `search`/`category` filters): marker counts, or hexagon density with `?resolution=1..10` | No |
| `POST` | `/api/reviews` | Create geo-indexed review with optional Cloudinary media. `location` is required; unless `location.precision` is `"exact"` the coordinates are rounded to about 1 km before they are stored | Yes |
| `POST` | `/api/reviews/:id/like` | Toggle like on a review | Yes |
| `POST` | `/api/reviews/:id/comments` | Add comment to a review | Yes |
| `POST` | `/api/agents/prospecting` | Trigger Autonomous AI Prospecting Agent | Yes (admin role) |
| `POST` | `/api/agents/deal-intelligence` | Trigger Autonomous AI Deal Intelligence Agent | Yes (admin role) |
| `POST` | `/api/agents/hexagon-summary` | Generate AI summary for an H3 hexagon cluster | No |
| `GET` | `/api/chat/conversations` | List user's active conversations | Yes |
| `GET` | `/api/chat/messages/:conversationId` | Fetch conversation message history | Yes |
| `POST` | `/api/chat/messages` | Send chat message with optional attachments | Yes |

---

## The Fraud Prevention Model

Reviewpedia's trust model is fundamentally different from existing platforms:

| Fraud Vector | Reviewpedia's Defense |
|---|---|
| Paid/fake text reviews | Reviews are geo-pinned — a paid reviewer must physically be in the claimed location |
| VPN location spoofing | Flagged as suspicious: frequent or impossible location changes trigger review holds |
| Multi-account spam | Same IP + location posting multiple reviews is flagged automatically |
| Coordinated review rings | Even if coordinated, impact is **local only** — it cannot inflate a national rating |
| Unverifiable reviewers | Reviewers earn trust scores through **in-person meetup ratings** from other users |

The proximity-first model is the core defence: if you claim to have bought a product in Koramangala, someone can literally walk over and verify that with you.

---

## Revenue Model

**D2C (Consumer):**
- Free to use — drives network effects and review volume

**B2B (Business Intelligence):**
- Brands pay for access to their product's hyperlocal review dashboard
- "I am Interested" demand signal data sold as market research
- Hyperlocal advertising placements for local businesses
- The AI Sales Agent system exists to **automate the acquisition of these B2B clients**

---

## Hackathon Context

This project was built for the **ET AI Hackathon 2026**, hosted by Economic Times with Avataar.ai and Unstop.

**Problem Statement 4: AI for Intelligent Sales & Revenue Operations**

> *"Design an AI agent that plugs into CRM and communication systems to accelerate the sales pipeline — from prospect research and personalized outreach to deal risk detection and revenue recovery."*

Reviewpedia's B2B layer IS the CRM. The geo-indexed review data IS the signal. The agents don't plug into an external CRM — they use the platform's own proprietary data as the pitch material. That's the differentiation.

**Submission requirements checklist:**
- [x] GitHub repository with source code and commit history
- [x] Architecture document (see `/docs` or the spec PDF)
- [x] 3-minute pitch video showing agents completing full workflows
- [x] Impact model with quantified business metrics

---

## Impact Model

### Prospecting Agent
- **Assumption:** 500 brands with 50+ reviews on platform, not yet B2B clients
- **Without agent:** Human sales rep researches and contacts ~5 brands/day = 100 days for full coverage
- **With agent:** Full 500-brand sweep in a single overnight run
- **Conversion rate:** 5% (industry standard for personalized cold outreach)
- **New clients generated:** 25 clients × ₹5,000/month = **₹1,25,000 new MRR per run**
- **Human hours saved:** ~100 hours/week of sales research

### Deal Intelligence Agent
- **Assumption:** 100 B2B clients at ₹5,000/month = ₹5,00,000 MRR
- **Baseline monthly churn:** 8% = 8 clients lost = ₹40,000 MRR lost
- **Churn reduction from proactive re-engagement:** 20% (industry benchmark)
- **Monthly MRR saved:** ₹8,000 → **₹96,000 saved annually** (growing as client base scales)

---

## Roadmap

- [ ] Reviewer verification via Aadhaar/DigiLocker integration
- [ ] In-app chat between users and reviewers
- [ ] Cross-platform rating aggregation (Amazon + Flipkart + brand website unified score)
- [ ] Competitive intelligence agent (track competitor review spikes)
- [ ] Voice-based review submission for low-literacy users
- [ ] Full RAG-powered AI assistant (`AIAssistant.jsx` — partially built)
- [ ] Mobile app (React Native)

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.

```bash
# Backend tests (needs a local MongoDB on 127.0.0.1:27017).
# They always use the separate `reviewpedia_test_db` database, never the one in .env,
# and never call Gemini, Resend or Cloudinary.
cd backend && npm test

# Build the frontend for production
cd frontend && npm run build

# Lint the frontend (flat config in frontend/eslint.config.js; fails on errors, reports warnings)
cd frontend && npm run lint
```

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">

Built with care for the **ET AI Hackathon 2026**

*Reviews from people around you. Intelligence for businesses that serve them.*

</div>
