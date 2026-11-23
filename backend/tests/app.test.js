import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import http from 'http';
import { Readable } from 'stream';

// The upload layer is stubbed: no test ever talks to Cloudinary. The stub records
// what would have been uploaded / deleted so tests can assert on it.
const uploadStub = vi.hoisted(() => ({ uploads: [], destroyed: [] }));
vi.mock('multer-storage-cloudinary', () => ({
    CloudinaryStorage: class {
        constructor(options) { this.options = options; }
        _handleFile(req, file, cb) {
            let size = 0;
            file.stream.on('data', chunk => { size += chunk.length; });
            file.stream.on('error', cb);
            file.stream.on('end', () => {
                const folder = this.options.params.folder;
                const isVideo = file.mimetype.startsWith('video/');
                const id = `${folder}/stub-${uploadStub.uploads.length + 1}`;
                uploadStub.uploads.push({ id, folder, mimetype: file.mimetype, size });
                cb(null, {
                    path: `https://res.cloudinary.com/test-cloud/${isVideo ? 'video' : 'image'}/upload/v1/${id}.${isVideo ? 'mp4' : 'png'}`,
                    filename: id,
                    size
                });
            });
        }
        _removeFile(req, file, cb) { cb(null); }
    }
}));
// The model is never called from tests: the summary agent is replaced by a counter.
const modelStub = vi.hoisted(() => ({ calls: [] }));
vi.mock('../services/agents/HexagonSummaryAgent.js', () => ({
    runHexagonSummaryAgent: async (reviews) => { modelStub.calls.push(reviews); return 'stub summary'; }
}));
vi.mock('cloudinary', () => ({
    v2: {
        config: () => {},
        uploader: {
            destroy: async (publicId) => { uploadStub.destroyed.push(publicId); return { result: 'ok' }; }
        }
    }
}));

// These tests write to the database, so they must NEVER run against the
// database configured in .env. The connection string is fixed to a dedicated
// local test database unless TEST_MONGODB_URI overrides it, and the database
// name must contain "test".
const TEST_DB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/reviewpedia_test_db';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.GEMINI_API_KEY = '';           // agents must not reach a paid API from tests
process.env.RESEND_API_KEY = '';           // no real email is ever sent
process.env.DEMO_RECIPIENT_EMAIL = '';
delete process.env.MONGODB_URI;

const { default: app } = await import('../app.js');
const { default: User } = await import('../models/User.js');
const { default: Review } = await import('../models/Review.js');
const { default: Comment } = await import('../models/Comment.js');
const { default: Conversation } = await import('../models/Conversation.js');
const { default: Message } = await import('../models/Message.js');
const { default: EmailOtp } = await import('../models/EmailOtp.js');
const { default: ChatUpload } = await import('../models/ChatUpload.js');
const { isAllowedOrigin, validateUsername } = await import('../utils/security.js');
const { assertPublicUrl, isBlockedAddress, fetchUrlMetadata, requestPinned, pinnedLookup } = await import('../utils/metadataFetcher.js');
const { MAX_MEDIA_LIMIT } = await import('../middlewares/uploadMiddleware.js');
const { resetSummaryBudget } = await import('../controllers/agentController.js');
const { getJwtSecret } = await import('../utils/jwtConfig.js');

const tokenFor = (user) => jwt.sign(
    { id: user._id.toString(), username: user.username, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
);
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });

const reviewDoc = (overrides = {}) => ({
    product: { name: 'Test Phone', brand: 'Acme', category: 'Electronics' },
    review: { title: 'Good', text: 'Works well', rating: 4, media: [] },
    location: { city: 'Delhi', lat: 28.61, lng: 77.2, h3Index: '893da164ebfffff' },
    source: { platform: 'Reviewpedia', isScraped: false },
    ...overrides
});

let dbAvailable = false;
let alice, bob, admin;

beforeAll(async () => {
    const dbName = new URL(TEST_DB_URI).pathname.replace('/', '');
    if (!/test/i.test(dbName)) {
        throw new Error(`Refusing to run tests against database "${dbName}": the name must contain "test".`);
    }
    try {
        await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 3000 });
        dbAvailable = true;
    } catch (e) {
        console.warn(`MongoDB not reachable at ${TEST_DB_URI}; database tests will be skipped. (${e.message})`);
    }
});

afterAll(async () => {
    if (dbAvailable) {
        await mongoose.connection.dropDatabase();
        await mongoose.connection.close();
    }
});

beforeEach(async (ctx) => {
    if (!dbAvailable) return;
    await Promise.all([User, Review, Comment, Conversation, Message, EmailOtp, ChatUpload].map(m => m.deleteMany({})));
    uploadStub.uploads.length = 0;
    uploadStub.destroyed.length = 0;
    [alice, bob, admin] = await User.create([
        { username: 'alice', email: 'alice@example.com', password: 'password1' },
        { username: 'bob', email: 'bob@example.com', password: 'password2' },
        { username: 'root', email: 'root@example.com', password: 'password3', role: 'admin' }
    ]);
});

const needsDb = (ctx) => { if (!dbAvailable) ctx.skip(); };

describe('Platform', () => {
    it('GET /api/health reports status', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('healthy');
        expect(res.body).toHaveProperty('uptime');
        expect(res.body).toHaveProperty('database');
    });

    it('unknown API routes return JSON 404', async () => {
        const res = await request(app).get('/api/does-not-exist');
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });

    it('malformed JSON returns 400, not 500', async () => {
        const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad');
        expect(res.status).toBe(400);
        expect(res.body.error.message).toMatch(/Malformed JSON/);
    });

    it('CORS: allowed origins are echoed, unknown origins get no CORS headers', async () => {
        const ok = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
        expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
        expect(ok.headers['access-control-allow-credentials']).toBe('true');

        const evil = await request(app).get('/api/health').set('Origin', 'https://evil.example');
        expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('origin allowlist logic', () => {
        expect(isAllowedOrigin(undefined)).toBe(true);
        expect(isAllowedOrigin('https://www.reviewpedia.co.in')).toBe(true);
        expect(isAllowedOrigin('https://app.reviewpedia.co.in')).toBe(true);
        expect(isAllowedOrigin('https://reviewpedia.co.in.evil.com')).toBe(false);
        expect(isAllowedOrigin('https://evilreviewpedia.co.in')).toBe(false);
        expect(isAllowedOrigin('https://anything.vercel.app')).toBe(false);
        process.env.ALLOW_VERCEL_PREVIEWS = 'true';
        expect(isAllowedOrigin('https://anything.vercel.app')).toBe(true);
        delete process.env.ALLOW_VERCEL_PREVIEWS;
        process.env.FRONTEND_URL = 'https://my-frontend.example/';
        expect(isAllowedOrigin('https://my-frontend.example')).toBe(true);
        delete process.env.FRONTEND_URL;
    });

    it('JWT secret: no public fallback outside local development and tests', () => {
        const saved = { secret: process.env.JWT_SECRET, env: process.env.NODE_ENV };
        delete process.env.JWT_SECRET;
        process.env.NODE_ENV = 'production';
        expect(() => getJwtSecret()).toThrow();
        delete process.env.NODE_ENV;
        expect(() => getJwtSecret()).toThrow();
        process.env.NODE_ENV = 'development';
        process.env.RENDER = '1';
        expect(() => getJwtSecret()).toThrow();
        delete process.env.RENDER;
        process.env.JWT_SECRET = saved.secret;
        process.env.NODE_ENV = saved.env;
        expect(getJwtSecret()).toBe(saved.secret);
    });
});

describe('Link preview SSRF protection', () => {
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const privateLookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];

    it('blocks loopback, private, link-local, CGNAT and IPv6 internal addresses', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
                          '0.0.0.0', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
            expect(isBlockedAddress(ip), ip).toBe(true);
        }
        for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
            expect(isBlockedAddress(ip), ip).toBe(false);
        }
    });

    it('rejects internal targets, odd schemes, ports and credentials', async () => {
        for (const url of ['http://[::1]:3001/', 'http://127.0.0.1/', 'http://localhost/', 'http://printer.local/',
                           'ftp://example.com/', 'file:///etc/passwd', 'http://example.com:6379/',
                           'http://user:pass@example.com/', 'http://169.254.169.254/latest/meta-data/']) {
            await expect(assertPublicUrl(url, publicLookup), url).rejects.toThrow();
        }
    });

    it('rejects a hostname that resolves to any private address', async () => {
        await expect(assertPublicUrl('https://rebind.example/', privateLookup)).rejects.toThrow(/non-public/);
        await expect(assertPublicUrl('https://example.com/page', publicLookup)).resolves.toBeInstanceOf(URL);
    });

    it('fetchUrlMetadata returns null for blocked targets without fetching', async () => {
        expect(await fetchUrlMetadata('http://[::1]:3001/api/health')).toBeNull();
        expect(await fetchUrlMetadata('http://127.0.0.1:27017/')).toBeNull();
        expect(await fetchUrlMetadata('x'.repeat(3000))).toBeNull();
    });
});

describe('Authentication', () => {
    it('protected routes reject missing and forged tokens', async (ctx) => {
        const none = await request(app).get('/api/auth/me');
        expect(none.status).toBe(401);
        const forged = jwt.sign({ id: '507f1f77bcf86cd799439011', role: 'admin' }, 'wrong-secret');
        const bad = await request(app).get('/api/chat/conversations').set('Authorization', `Bearer ${forged}`);
        expect(bad.status).toBe(401);
        const expired = jwt.sign({ id: '507f1f77bcf86cd799439011' }, process.env.JWT_SECRET, { expiresIn: -10 });
        const old = await request(app).get('/api/chat/conversations').set('Authorization', `Bearer ${expired}`);
        expect(old.status).toBe(401);
    });

    it('login works with correct credentials, case-insensitive email', async (ctx) => {
        needsDb(ctx);
        const res = await request(app).post('/api/auth/login').send({ email: 'Alice@Example.com ', password: 'password1' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.user.username).toBe('alice');
        expect(res.body.user).not.toHaveProperty('password');
    });

    it('login rejects wrong password, unknown user and missing fields', async (ctx) => {
        needsDb(ctx);
        for (const body of [{ email: 'alice@example.com', password: 'nope' }, { email: 'ghost@example.com', password: 'x' }, {}]) {
            const res = await request(app).post('/api/auth/login').send(body);
            expect([400, 401]).toContain(res.status);
            expect(res.body.success).toBe(false);
        }
    });

    it('login rejects NoSQL operator injection', async (ctx) => {
        needsDb(ctx);
        const res = await request(app).post('/api/auth/login').send({ email: { $ne: null }, password: 'password1' });
        expect([400, 401]).toContain(res.status);
        expect(res.body.success).toBe(false);
        expect(res.body.token).toBeUndefined();
    });

    it('passwords are stored hashed', async (ctx) => {
        needsDb(ctx);
        const stored = await User.findById(alice._id);
        expect(stored.password).not.toBe('password1');
        expect(stored.password).toMatch(/^\$2[aby]\$/);
    });

    it('public profile lookup does not expose the email address', async (ctx) => {
        needsDb(ctx);
        const res = await request(app).get('/api/auth/user/alice');
        expect(res.status).toBe(200);
        expect(res.body.user.username).toBe('alice');
        expect(res.body.user.email).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain('alice@example.com');
    });

    it('GET /auth/me is not throttled by the login rate limiter', async (ctx) => {
        needsDb(ctx);
        const res = await request(app).get('/api/auth/me').set(auth(alice));
        expect(res.status).toBe(200);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
    });
});

describe('Reviews', () => {
    const create = (user, data) => request(app).post('/api/reviews').set(auth(user)).send(data);
    const valid = { product: { name: 'Kettle', brand: 'Acme', category: 'Home' }, review: { text: 'Boils fast', rating: 4.5 }, location: { lat: 28.6, lng: 77.2 } };

    it('listing is public and returns an array', async (ctx) => {
        needsDb(ctx);
        await Review.create(reviewDoc());
        const res = await request(app).get('/api/reviews');
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].product.name).toBe('Test Phone');
    });

    it('creating requires authentication', async () => {
        const res = await request(app).post('/api/reviews').send(valid);
        expect(res.status).toBe(401);
    });

    it('creates a review owned by the caller and ignores privileged client fields', async (ctx) => {
        needsDb(ctx);
        const res = await create(alice, {
            ...valid,
            likes: ['x', 'y', 'z'],
            analytics: { trustScore: 100 },
            source: { platform: 'Flipkart', isScraped: true },
            user: { id: bob._id.toString(), name: 'bob' }
        });
        expect(res.status).toBe(201);
        expect(res.body.user.name).toBe('alice');
        expect(res.body.user.id).toBe(alice._id.toString());
        expect(res.body.likes).toEqual([]);
        expect(res.body.analytics.trustScore).toBe(0);
        expect(res.body.source).toEqual({ platform: 'Reviewpedia', isScraped: false });
        expect(res.body.review.rating).toBe(4.5);
        expect(res.body.location.h3Index).toMatch(/^[0-9a-f]{15}$/);
        expect(await Review.countDocuments()).toBe(1);
    });

    it('rejects invalid input with 400 and stores nothing', async (ctx) => {
        needsDb(ctx);
        const cases = [
            { ...valid, product: { name: '' } },
            { ...valid, review: { text: 'x', rating: 9 } },
            { ...valid, review: { text: 'x', rating: 0 } },
            { ...valid, review: { text: 'x', rating: 3.3 } },
            { ...valid, review: { text: 'x', rating: 'great' } },
            { ...valid, review: { text: 'y'.repeat(5001), rating: 4 } },
            { ...valid, location: { lat: 999, lng: 77 } },
            { ...valid, location: { lat: 'north', lng: 77 } }
        ];
        for (const body of cases) {
            const res = await create(alice, body);
            expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
        }
        expect(await Review.countDocuments()).toBe(0);
    });

    it('only the owner (or an admin) can edit or delete a review', async (ctx) => {
        needsDb(ctx);
        const id = (await create(alice, valid)).body.id;

        const editByBob = await request(app).put(`/api/reviews/${id}`).set(auth(bob)).send({ review: { text: 'hacked', rating: 1 } });
        expect(editByBob.status).toBe(403);
        const linkByBob = await request(app).patch(`/api/reviews/${id}/purchase-info`).set(auth(bob)).send({ purchaseLink: 'https://evil.example' });
        expect(linkByBob.status).toBe(403);
        const delByBob = await request(app).delete(`/api/reviews/${id}`).set(auth(bob));
        expect(delByBob.status).toBe(403);
        expect((await Review.findById(id)).review.text).toBe('Boils fast');

        const editByOwner = await request(app).put(`/api/reviews/${id}`).set(auth(alice)).send({ review: { text: 'Still good', rating: 5 } });
        expect(editByOwner.status).toBe(200);
        expect(editByOwner.body.review.text).toBe('Still good');
        const badRating = await request(app).put(`/api/reviews/${id}`).set(auth(alice)).send({ review: { rating: 11 } });
        expect(badRating.status).toBe(400);

        const delByAdmin = await request(app).delete(`/api/reviews/${id}`).set(auth(admin));
        expect(delByAdmin.status).toBe(200);
        expect(await Review.findById(id)).toBeNull();
    });

    it('registering the name on an imported review does not grant ownership of it', async (ctx) => {
        needsDb(ctx);
        // Imported reviews carry a display name but no account id.
        const scraped = await Review.create(reviewDoc({ user: { name: 'alice' }, source: { platform: 'Flipkart', isScraped: true } }));
        const del = await request(app).delete(`/api/reviews/${scraped._id}`).set(auth(alice));
        expect(del.status).toBe(403);
        const edit = await request(app).put(`/api/reviews/${scraped._id}`).set(auth(alice)).send({ review: { text: 'mine now' } });
        expect(edit.status).toBe(403);
        expect(await Review.findById(scraped._id)).not.toBeNull();
    });

    it('edit cannot attach media that does not already belong to the review', async (ctx) => {
        needsDb(ctx);
        const mine = 'https://res.cloudinary.com/test-cloud/image/upload/v1/reviewpedia/mine.jpg';
        const victim = 'https://res.cloudinary.com/test-cloud/image/upload/v1/reviewpedia/victim.jpg';
        const review = await Review.create(reviewDoc({
            user: { id: alice._id, name: 'alice' },
            review: { title: 't', text: 'x', rating: 4, media: [{ type: 'image', url: mine, size: 1000 }] }
        }));
        const res = await request(app).put(`/api/reviews/${review._id}`).set(auth(alice)).send({
            review: { text: 'x' },
            existingMedia: [{ type: 'image', url: mine, size: -999999 }, { type: 'image', url: victim, size: 1 }]
        });
        expect(res.status).toBe(200);
        expect(res.body.review.media.map(m => m.url)).toEqual([mine]);
        expect(res.body.review.media[0].size).toBe(1000); // stored size kept, client value ignored
    });

    it('invalid ids return 400 and unknown ids 404', async (ctx) => {
        needsDb(ctx);
        expect((await request(app).get('/api/reviews/not-an-id')).status).toBe(400);
        expect((await request(app).get('/api/reviews/507f1f77bcf86cd799439011')).status).toBe(404);
        expect((await request(app).delete('/api/reviews/not-an-id').set(auth(alice))).status).toBe(400);
        expect((await request(app).get('/api/reviews/not-an-id/comments')).status).toBe(400);
    });

    it('likes toggle per user and ignore identities in the body', async (ctx) => {
        needsDb(ctx);
        const id = (await create(alice, valid)).body.id;
        const like = await request(app).post(`/api/reviews/${id}/like`).set(auth(bob)).send({ userId: 'someone-else' });
        expect(like.body).toMatchObject({ isLiked: true, likesCount: 1 });
        expect(like.body.likes).toEqual([bob._id.toString()]);
        const unlike = await request(app).post(`/api/reviews/${id}/like`).set(auth(bob));
        expect(unlike.body).toMatchObject({ isLiked: false, likesCount: 0 });
    });

    it('comments: create, reply, authorize deletion, and cascade with the review', async (ctx) => {
        needsDb(ctx);
        const id = (await create(alice, valid)).body.id;
        const otherId = (await create(alice, { ...valid, product: { name: 'Other' } })).body.id;

        expect((await request(app).post(`/api/reviews/${id}/comments`).send({ text: 'hi' })).status).toBe(401);
        expect((await request(app).post(`/api/reviews/${id}/comments`).set(auth(bob)).send({ text: '   ' })).status).toBe(400);
        expect((await request(app).post(`/api/reviews/${id}/comments`).set(auth(bob)).send({ text: { $gt: '' } })).status).toBe(400);

        const c1 = await request(app).post(`/api/reviews/${id}/comments`).set(auth(bob)).send({ text: 'Nice review' });
        expect(c1.status).toBe(201);
        expect(c1.body.user.name).toBe('bob');
        const reply = await request(app).post(`/api/reviews/${id}/comments`).set(auth(alice)).send({ text: 'Thanks', parentId: c1.body.id });
        expect(reply.status).toBe(201);

        // A reply cannot hang off a comment that belongs to a different review.
        const cross = await request(app).post(`/api/reviews/${otherId}/comments`).set(auth(alice)).send({ text: 'x', parentId: c1.body.id });
        expect(cross.status).toBe(404);

        const delByAlice = await request(app).delete(`/api/reviews/${id}/comments/${c1.body.id}`).set(auth(alice));
        expect(delByAlice.status).toBe(403);

        const list = await request(app).get(`/api/reviews/${id}/comments`);
        expect(list.body).toHaveLength(2);

        // Deleting the review removes its comments.
        expect((await request(app).delete(`/api/reviews/${id}`).set(auth(alice))).status).toBe(200);
        expect(await Comment.countDocuments({ reviewId: id })).toBe(0);
    });
});

describe('Chat authorization', () => {
    let convo, carol;
    beforeEach(async () => {
        if (!dbAvailable) return;
        carol = await User.create({ username: 'carol', email: 'carol@example.com', password: 'password4' });
        convo = await Conversation.create({ participants: [alice._id, bob._id], lastMessage: 'Conversation started' });
        await Message.create({ conversationId: convo._id, sender: alice._id, text: 'private hello' });
    });

    it('participants can read; outsiders cannot read, write or mark as read', async (ctx) => {
        needsDb(ctx);
        const byBob = await request(app).get(`/api/chat/messages/${convo._id}`).set(auth(bob));
        expect(byBob.status).toBe(200);
        expect(byBob.body.messages).toHaveLength(1);

        const byCarol = await request(app).get(`/api/chat/messages/${convo._id}`).set(auth(carol));
        expect(byCarol.status).toBe(403);
        expect(JSON.stringify(byCarol.body)).not.toContain('private hello');

        const inject = await request(app).post('/api/chat/messages').set(auth(carol))
            .send({ conversationId: convo._id.toString(), text: 'injected', receiverId: bob._id.toString() });
        expect(inject.status).toBe(403);

        const markRead = await request(app).put(`/api/chat/conversations/${convo._id}/read`).set(auth(carol));
        expect(markRead.status).toBe(403);

        const del = await request(app).delete(`/api/chat/conversations/${convo._id}`).set(auth(carol));
        expect(del.status).toBe(403);

        expect(await Message.countDocuments({ conversationId: convo._id })).toBe(1);
    });

    it('reading as an outsider does not mark messages as read', async (ctx) => {
        needsDb(ctx);
        await request(app).get(`/api/chat/messages/${convo._id}`).set(auth(carol));
        const msg = await Message.findOne({ conversationId: convo._id });
        expect(msg.read).toBe(false);
    });

    it('participants can send; message is persisted with the sender from the token', async (ctx) => {
        needsDb(ctx);
        const res = await request(app).post('/api/chat/messages').set(auth(bob))
            .send({ conversationId: convo._id.toString(), text: '  hi alice  ', sender: alice._id.toString() });
        expect(res.status).toBe(200);
        expect(res.body.message.text).toBe('hi alice');
        expect(res.body.message.sender._id).toBe(bob._id.toString());
        expect((await Conversation.findById(convo._id)).lastMessage).toBe('hi alice');
    });

    it('rejects empty messages, foreign media URLs and media the sender never uploaded', async (ctx) => {
        needsDb(ctx);
        const send = (body) => request(app).post('/api/chat/messages').set(auth(bob)).send({ conversationId: convo._id.toString(), ...body });
        expect((await send({})).status).toBe(400);
        expect((await send({ text: 'x'.repeat(5001) })).status).toBe(400);
        expect((await send({ mediaUrl: 'https://res.cloudinary.com/someone-else/image/upload/a.jpg', mediaType: 'image', mediaSize: 10 })).status).toBe(400);
        // A file in our own account, but not one bob uploaded (e.g. someone's review image).
        const victimUrl = 'https://res.cloudinary.com/test-cloud/image/upload/v1/reviewpedia/victim.jpg';
        expect((await send({ mediaUrl: victimUrl, mediaType: 'image', mediaSize: 0 })).status).toBe(400);
        expect((await send({ mediaUrl: victimUrl, mediaType: 'script' })).status).toBe(400);
        expect((await User.findById(bob._id)).totalMediaBytes).toBe(0);
        expect(await Message.countDocuments({ conversationId: convo._id })).toBe(1);
    });

    it('invalid conversation ids return 400; conversations list only shows own', async (ctx) => {
        needsDb(ctx);
        expect((await request(app).get('/api/chat/messages/not-an-id').set(auth(bob))).status).toBe(400);
        const list = await request(app).get('/api/chat/conversations').set(auth(carol));
        expect(list.body.conversations).toHaveLength(0);
        const mine = await request(app).get('/api/chat/conversations').set(auth(alice));
        expect(mine.body.conversations).toHaveLength(1);
    });

    it('cannot start a conversation with yourself or with a non-string username', async (ctx) => {
        needsDb(ctx);
        expect((await request(app).post('/api/chat/conversations').set(auth(alice)).send({ targetUsername: 'alice' })).status).toBe(400);
        expect((await request(app).post('/api/chat/conversations').set(auth(alice)).send({ targetUsername: { $ne: '' } })).status).toBe(400);
        const ok = await request(app).post('/api/chat/conversations').set(auth(alice)).send({ targetUsername: 'carol' });
        expect(ok.status).toBe(200);
    });

    it('only the sender can delete a message', async (ctx) => {
        needsDb(ctx);
        const msg = await Message.findOne({ conversationId: convo._id });
        expect((await request(app).delete(`/api/chat/messages/${msg._id}`).set(auth(bob))).status).toBe(403);
        expect((await request(app).delete(`/api/chat/messages/${msg._id}`).set(auth(alice))).status).toBe(200);
    });
});

describe('Agents', () => {
    it('agent triggers require authentication', async () => {
        for (const path of ['/api/agents/prospecting', '/api/agents/deal-intelligence']) {
            const res = await request(app).post(path).send({ demoEmail: 'demo@example.com' });
            expect(res.status).toBe(401);
            expect(res.body.success).toBe(false);
        }
    });

    it('agents cannot be pointed at an arbitrary recipient address', async (ctx) => {
        needsDb(ctx);
        process.env.GEMINI_API_KEY = 'test-key-not-used';
        try {
            const res = await request(app).post('/api/agents/prospecting').set(auth(admin)).send({ demoEmail: 'victim@elsewhere.example' });
            expect(res.status).toBe(403);
            expect(JSON.stringify(res.body)).not.toMatch(/admin account/);   // refused for the recipient, not the role
            const res2 = await request(app).post('/api/agents/deal-intelligence').set(auth(admin)).send({ demoEmail: 'victim@elsewhere.example' });
            expect(res2.status).toBe(403);
        } finally {
            process.env.GEMINI_API_KEY = '';
        }
    });

    it('only admin accounts can start the emailing agents', async (ctx) => {
        needsDb(ctx);
        process.env.GEMINI_API_KEY = 'test-key-not-used';
        modelStub.calls.length = 0;
        try {
            for (const path of ['/api/agents/prospecting', '/api/agents/deal-intelligence']) {
                // An ordinary signed-in user is refused before anything runs.
                const asUser = await request(app).post(path).set(auth(alice)).send({});
                expect(asUser.status, path).toBe(403);
                expect(asUser.body.error).toMatch(/admin account/);

                // A token that claims to be admin does not help: the role is read from the database.
                const forged = jwt.sign({ id: alice._id.toString(), username: alice.username, email: alice.email, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
                const asForged = await request(app).post(path).set({ Authorization: `Bearer ${forged}` }).send({});
                expect(asForged.status, path).toBe(403);
                expect(asForged.body.error).toMatch(/admin account/);

                // An admin gets past the role check.
                const asAdmin = await request(app).post(path).set(auth(admin)).send({});
                expect(JSON.stringify(asAdmin.body), path).not.toMatch(/admin account/);
            }

            // Granting the role takes effect on the next request; removing it does too.
            await User.updateOne({ _id: alice._id }, { role: 'admin' });
            const promoted = await request(app).post('/api/agents/prospecting').set(auth(alice)).send({ demoEmail: 'victim@elsewhere.example' });
            expect(JSON.stringify(promoted.body)).not.toMatch(/admin account/);
            await User.updateOne({ _id: alice._id }, { role: 'user' });
            expect((await request(app).post('/api/agents/prospecting').set(auth(alice)).send({})).body.error).toMatch(/admin account/);
        } finally {
            process.env.GEMINI_API_KEY = '';
        }
    });

    it('hexagon summary validates its payload before calling the model', async () => {
        process.env.GEMINI_API_KEY = 'test-key-not-used';
        try {
            for (const body of [{}, { reviews: 'x' }, { reviews: [] }, { reviews: [null, 5, { rating: 5 }] }]) {
                const res = await request(app).post('/api/agents/hexagon-summary').send(body);
                expect(res.status, JSON.stringify(body)).toBe(400);
            }
        } finally {
            process.env.GEMINI_API_KEY = '';
        }
    });
});

describe('Agent caps (model stubbed)', () => {
    const summary = (body) => request(app).post('/api/agents/hexagon-summary').send(body);

    it('the public summary sends the model at most 50 reviews of at most 600 characters', async () => {
        process.env.GEMINI_API_KEY = 'test-key-not-used';
        resetSummaryBudget();
        modelStub.calls.length = 0;
        try {
            const reviews = Array.from({ length: 150 }, (_, i) => ({ rating: 99, text: `review ${i} ` + 'x'.repeat(900), extra: 'ignored' }));
            const res = await summary({ reviews });
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, result: 'stub summary' });
            expect(modelStub.calls).toHaveLength(1);
            const sent = modelStub.calls[0];
            expect(sent).toHaveLength(50);
            expect(sent.every(r => r.text.length <= 600 && r.rating <= 5 && Object.keys(r).length === 2)).toBe(true);
        } finally {
            process.env.GEMINI_API_KEY = '';
        }
    });

    it('the public summary has an hourly budget shared by all callers', async () => {
        process.env.GEMINI_API_KEY = 'test-key-not-used';
        process.env.PUBLIC_SUMMARY_HOURLY_BUDGET = '3';
        resetSummaryBudget();
        modelStub.calls.length = 0;
        try {
            const body = { reviews: [{ rating: 4, text: 'fine' }] };
            const statuses = [];
            for (let i = 0; i < 6; i++) statuses.push((await summary(body)).status);
            expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
            expect(modelStub.calls).toHaveLength(3);
            // Invalid requests never reach the model and do not use up the budget.
            resetSummaryBudget();
            for (let i = 0; i < 5; i++) expect((await summary({ reviews: [] })).status).toBe(400);
            expect((await summary(body)).status).toBe(200);
        } finally {
            process.env.GEMINI_API_KEY = '';
            delete process.env.PUBLIC_SUMMARY_HOURLY_BUDGET;
            resetSummaryBudget();
        }
    });

    it('signed-out callers cannot start the emailing agents, with or without a model key', async () => {
        process.env.GEMINI_API_KEY = 'test-key-not-used';
        try {
            for (const path of ['/api/agents/prospecting', '/api/agents/deal-intelligence']) {
                expect((await request(app).post(path).send({})).status).toBe(401);
            }
        } finally {
            process.env.GEMINI_API_KEY = '';
        }
    });
});

describe('Account lifecycle and privacy', () => {
    it('a token stops working as soon as its account is deleted', async (ctx) => {
        needsDb(ctx);
        const headers = auth(bob);
        expect((await request(app).get('/api/auth/me').set(headers)).status).toBe(200);
        await User.findByIdAndDelete(bob._id);
        expect((await request(app).get('/api/auth/me').set(headers)).status).toBe(401);
        const post = await request(app).post('/api/reviews').set(headers)
            .send({ product: { name: 'Ghost' }, review: { text: 'x', rating: 4 } });
        expect(post.status).toBe(401);
        expect(await Review.countDocuments()).toBe(0);
    });

    it('a role change applies immediately, not when the token expires', async (ctx) => {
        needsDb(ctx);
        const review = await Review.create(reviewDoc({ user: { id: alice._id, name: 'alice' } }));
        const headers = auth(admin);                       // token still says role: admin
        await User.findByIdAndUpdate(admin._id, { role: 'user' });
        const res = await request(app).delete(`/api/reviews/${review._id}`).set(headers);
        expect(res.status).toBe(403);
    });

    it('forgot-password answers the same for known and unknown emails', async (ctx) => {
        needsDb(ctx);
        const known = await request(app).post('/api/auth/send-forgot-password-otp').send({ email: 'alice@example.com' });
        const unknown = await request(app).post('/api/auth/send-forgot-password-otp').send({ email: 'nobody@example.com' });
        expect(known.status).toBe(200);
        expect(unknown.status).toBe(200);
        expect(unknown.body.success).toBe(true);
    });

    it('public profile returns real review activity', async (ctx) => {
        needsDb(ctx);
        await Review.create([
            reviewDoc({ user: { id: alice._id, name: 'alice' }, product: { name: 'First' } }),
            reviewDoc({ user: { id: alice._id, name: 'alice' }, product: { name: 'Second' } }),
            reviewDoc({ user: { id: bob._id, name: 'bob' }, product: { name: 'Not hers' } })
        ]);
        const res = await request(app).get('/api/auth/user/alice');
        expect(res.status).toBe(200);
        expect(res.body.reviewCount).toBe(2);
        expect(res.body.recentReviews.map(r => r.productName).sort()).toEqual(['First', 'Second']);
        expect((await request(app).get('/api/auth/user/nobody')).status).toBe(404);
    });
});

describe('One live code per address', () => {
    it('simultaneous "send code" requests leave exactly one code', async (ctx) => {
        needsDb(ctx);
        await EmailOtp.syncIndexes();
        const send = () => request(app).post('/api/auth/send-forgot-password-otp').send({ email: 'alice@example.com' });
        const results = await Promise.all(Array.from({ length: 12 }, send));
        expect(results.every(r => r.status === 200)).toBe(true);
        expect(await EmailOtp.countDocuments({ email: 'alice@example.com', purpose: 'forgot_password' })).toBe(1);

        // A different purpose for the same address is a separate code.
        await EmailOtp.create({ email: 'alice@example.com', purpose: 'signup', otp: '111111' });
        expect(await EmailOtp.countDocuments({ email: 'alice@example.com' })).toBe(2);
        // A second record for the same address and purpose is refused by the database.
        await expect(EmailOtp.create({ email: 'alice@example.com', purpose: 'signup', otp: '222222' })).rejects.toMatchObject({ code: 11000 });
    });
});

describe('OTP attempts are atomic', () => {
    const CODE = '424242';
    const signupBody = (otp, username = 'newuser') => ({ username, email: 'new@example.com', password: 'password9', otp });
    const giveCode = (purpose, email) => EmailOtp.create({ email, purpose, otp: CODE });

    it('parallel wrong guesses get exactly 5 attempts in total, then the code is dead', async (ctx) => {
        needsDb(ctx);
        await giveCode('signup', 'new@example.com');
        // 60 different wrong codes at once. With a read-then-write counter every one
        // of them would have been compared against the real code.
        const guesses = Array.from({ length: 60 }, (_, i) => String(100000 + i));
        const results = await Promise.all(guesses.map(g => request(app).post('/api/auth/register').send(signupBody(g))));
        expect(results.every(r => r.status === 400)).toBe(true);
        const compared = results.filter(r => /Invalid verification code/.test(r.body.error)).length;
        expect(compared).toBe(5);
        expect(results.filter(r => /Too many incorrect attempts|expired or not found/.test(r.body.error)).length).toBe(55);

        // Lockout holds: even the correct code is refused now, and no account exists.
        const late = await request(app).post('/api/auth/register').send(signupBody(CODE));
        expect(late.status).toBe(400);
        expect(await User.countDocuments({ email: 'new@example.com' })).toBe(0);
        expect(await EmailOtp.countDocuments({ email: 'new@example.com' })).toBe(0);
    });

    it('a correct code among parallel guesses cannot be reached after the attempts are used', async (ctx) => {
        needsDb(ctx);
        // 200 parallel guesses that include the right code: at most 5 are compared,
        // so the account is created at most once and only if the right code was one of those 5.
        await giveCode('signup', 'new@example.com');
        const guesses = Array.from({ length: 199 }, (_, i) => String(500000 + i)).concat(CODE);
        const results = await Promise.all(guesses.map(g => request(app).post('/api/auth/register').send(signupBody(g))));
        const compared = results.filter(r => r.status === 201 || /Invalid verification code/.test(r.body.error)).length;
        expect(compared).toBeLessThanOrEqual(5);
        expect(await User.countDocuments({ email: 'new@example.com' })).toBeLessThanOrEqual(1);
    });

    it('the correct code works once, also when submitted in parallel', async (ctx) => {
        needsDb(ctx);
        await giveCode('signup', 'new@example.com');
        const results = await Promise.all(Array.from({ length: 4 }, () => request(app).post('/api/auth/register').send(signupBody(CODE))));
        expect(results.filter(r => r.status === 201)).toHaveLength(1);
        expect(await User.countDocuments({ email: 'new@example.com' })).toBe(1);
        // Used up: a replay fails.
        expect((await request(app).post('/api/auth/register').send(signupBody(CODE, 'another'))).status).toBe(400);
    });

    it('a few wrong attempts followed by the right code still succeeds', async (ctx) => {
        needsDb(ctx);
        await giveCode('signup', 'new@example.com');
        for (const wrong of ['000001', '000002']) {
            expect((await request(app).post('/api/auth/register').send(signupBody(wrong))).status).toBe(400);
        }
        expect((await EmailOtp.findOne({ email: 'new@example.com' })).attempts).toBe(2);
        expect((await request(app).post('/api/auth/register').send(signupBody(CODE))).status).toBe(201);
    });

    it('password reset: lockout after 5 wrong codes, password unchanged', async (ctx) => {
        needsDb(ctx);
        await giveCode('forgot_password', 'alice@example.com');
        const attempt = (otp) => request(app).post('/api/auth/reset-password').send({ email: 'alice@example.com', otp, newPassword: 'hijacked1' });
        const wrong = await Promise.all(Array.from({ length: 30 }, (_, i) => attempt(String(700000 + i))));
        expect(wrong.filter(r => /Invalid verification code/.test(r.body.error))).toHaveLength(5);
        expect((await attempt(CODE)).status).toBe(400);
        expect((await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'password1' })).status).toBe(200);
        expect((await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'hijacked1' })).status).toBe(401);
    });

    it('email change: wrong codes are counted the same way', async (ctx) => {
        needsDb(ctx);
        await giveCode('email_update', 'alice-new@example.com');
        const change = (otp) => request(app).put('/api/auth/profile').set(auth(alice)).send({ username: 'alice', email: 'alice-new@example.com', otp });
        const wrong = await Promise.all(Array.from({ length: 20 }, (_, i) => change(String(800000 + i))));
        expect(wrong.filter(r => /Invalid verification code/.test(r.body.error))).toHaveLength(5);
        expect((await change(CODE)).status).toBe(400);
        expect((await User.findById(alice._id)).email).toBe('alice@example.com');
    });
});

describe('Review pagination and map statistics', () => {
    // Three places; the third gets most of the reviews.
    const PLACES = [
        { city: 'Delhi', lat: 28.61, lng: 77.2 },
        { city: 'Mumbai', lat: 19.07, lng: 72.87 },
        { city: 'Pune', lat: 18.52, lng: 73.85 }
    ];
    let h3;
    const seed = async (count, extra = () => ({})) => {
        h3 = await import('h3-js');
        const docs = Array.from({ length: count }, (_, i) => {
            const place = PLACES[i % 7 === 0 ? 0 : i % 7 === 1 ? 1 : 2];
            return reviewDoc({
                product: { name: `Item ${i}`, brand: 'Acme', category: i % 2 ? 'Electronics' : 'Home' },
                review: { title: 't', text: `text ${i}`, rating: (i % 5) + 1, media: [] },
                location: { ...place, h3Index: h3.latLngToCell(place.lat, place.lng, 9) },
                ...extra(i)
            });
        });
        await Review.insertMany(docs);
    };

    it('pages through every review exactly once, newest first', async (ctx) => {
        needsDb(ctx);
        await seed(45);
        const seen = [];
        let cursor;
        let pages = 0;
        do {
            const res = await request(app).get('/api/reviews').query({ limit: 20, ...(cursor ? { cursor } : {}) });
            expect(res.status).toBe(200);
            expect(res.body.total).toBe(45);
            expect(res.body.limit).toBe(20);
            seen.push(...res.body.reviews.map(r => r.id));
            cursor = res.body.nextCursor;
            pages++;
        } while (cursor && pages < 10);
        expect(pages).toBe(3);
        expect(seen).toHaveLength(45);
        expect(new Set(seen).size).toBe(45);
        expect([...seen].sort().reverse()).toEqual(seen); // ids descending = newest first
    });

    it('page size is validated and capped; a bad cursor is a 400', async (ctx) => {
        needsDb(ctx);
        await seed(130);
        const big = await request(app).get('/api/reviews').query({ limit: 5000 });
        expect(big.body.reviews).toHaveLength(100);
        expect(big.body.limit).toBe(100);
        expect(big.body.nextCursor).toBeTruthy();
        for (const limit of ['0', '-3', 'abc', '2.5']) {
            expect((await request(app).get('/api/reviews').query({ limit })).status, limit).toBe(400);
        }
        expect((await request(app).get('/api/reviews').query({ cursor: 'nope' })).status).toBe(400);
        expect((await request(app).get('/api/reviews').query({ limit: 5, h3Index: 'zz' })).status).toBe(400);
        expect((await request(app).get('/api/reviews').query({ limit: 5, userId: 'zz' })).status).toBe(400);
        expect((await request(app).get('/api/reviews').query({ limit: 5, cell: 'zz' })).status).toBe(400);
    });

    it('callers that do not paginate still get the plain array', async (ctx) => {
        needsDb(ctx);
        await seed(12);
        const res = await request(app).get('/api/reviews');
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(12);
        const filtered = await request(app).get('/api/reviews').query({ category: 'Home' });
        expect(filtered.body).toHaveLength(6);
    });

    it('filters by map marker, by author and by hexagon, with correct totals', async (ctx) => {
        needsDb(ctx);
        await seed(70, (i) => (i < 9 ? { user: { id: alice._id, name: 'alice' } } : {}));
        const delhiCell = h3.latLngToCell(PLACES[0].lat, PLACES[0].lng, 9);
        const marker = await request(app).get('/api/reviews').query({ limit: 50, h3Index: delhiCell });
        expect(marker.body.total).toBe(10);                       // i % 7 === 0 for i < 70
        expect(marker.body.reviews.every(r => r.location.city === 'Delhi')).toBe(true);

        const mine = await request(app).get('/api/reviews').query({ limit: 5, userId: alice._id.toString() });
        expect(mine.body.total).toBe(9);
        expect(mine.body.reviews).toHaveLength(5);
        expect(mine.body.nextCursor).toBeTruthy();

        // A coarse hexagon around Pune also contains nothing from Delhi or Mumbai.
        const puneHex = h3.latLngToCell(PLACES[2].lat, PLACES[2].lng, 5);
        const hex = await request(app).get('/api/reviews').query({ limit: 100, cell: puneHex });
        expect(hex.body.total).toBe(50);
        expect(hex.body.reviews.every(r => r.location.city === 'Pune')).toBe(true);
        const emptyHex = await request(app).get('/api/reviews').query({ limit: 10, cell: h3.latLngToCell(0, 0, 5) });
        expect(emptyHex.body.total).toBe(0);
    });

    it('map statistics cover the full set, beyond the 500 the plain list returns', async (ctx) => {
        needsDb(ctx);
        await seed(640);
        const legacy = await request(app).get('/api/reviews');
        expect(legacy.body).toHaveLength(500);

        const stats = await request(app).get('/api/reviews/map-stats');
        expect(stats.status).toBe(200);
        expect(stats.body.total).toBe(640);
        expect(stats.body.cells).toHaveLength(3);
        expect(stats.body.cells.reduce((sum, c) => sum + c.count, 0)).toBe(640);

        // Expected numbers computed independently from the same seed rule.
        const expected = {};
        for (let i = 0; i < 640; i++) {
            const place = PLACES[i % 7 === 0 ? 0 : i % 7 === 1 ? 1 : 2];
            const e = (expected[place.city] ||= { count: 0, sum: 0, min: 9, max: 0, lat: place.lat, lng: place.lng });
            const rating = (i % 5) + 1;
            e.count++; e.sum += rating; e.min = Math.min(e.min, rating); e.max = Math.max(e.max, rating);
        }
        for (const e of Object.values(expected)) {
            const cell = stats.body.cells.find(c => c.h3Index === h3.latLngToCell(e.lat, e.lng, 9));
            expect(cell).toMatchObject({ count: e.count, minRating: e.min, maxRating: e.max, lat: e.lat, lng: e.lng });
            expect(cell.avgRating).toBe(Math.round((e.sum / e.count) * 10) / 10);
            expect(cell.boundary).toBeUndefined();
        }
    });

    it('hexagon statistics honour the resolution and the same filters as the list', async (ctx) => {
        needsDb(ctx);
        await seed(70);
        const coarse = await request(app).get('/api/reviews/map-stats').query({ resolution: 2 });
        // Mumbai and Pune are ~120 km apart and share a resolution-2 hexagon; Delhi does not.
        expect(coarse.body.cells).toHaveLength(2);
        expect(coarse.body.cells[0].count).toBe(60);
        expect(coarse.body.cells[0].boundary.length).toBeGreaterThanOrEqual(6);
        expect(coarse.body.cells[0].h3Index).toBe(h3.latLngToCell(PLACES[2].lat, PLACES[2].lng, 2));

        const home = await request(app).get('/api/reviews/map-stats').query({ category: 'Home' });
        expect(home.body.total).toBe(35);
        const listHome = await request(app).get('/api/reviews').query({ category: 'Home', limit: 1 });
        expect(listHome.body.total).toBe(35);

        const search = await request(app).get('/api/reviews/map-stats').query({ search: 'Mumbai' });
        expect(search.body.total).toBe(10);

        for (const resolution of ['0', '11', 'x', '3.5']) {
            expect((await request(app).get('/api/reviews/map-stats').query({ resolution })).status, resolution).toBe(400);
        }
    });
});

describe('Location privacy', () => {
    const base = { product: { name: 'Lamp', category: 'Home' }, review: { text: 'Bright', rating: 4 } };
    const precise = { lat: 28.613912, lng: 77.209021 };
    const post = (user, location) => request(app).post('/api/reviews').set(auth(user)).send({ ...base, ...(location === undefined ? {} : { location }) });

    it('approximate (and unspecified) locations are coarsened before they are stored', async (ctx) => {
        needsDb(ctx);
        for (const location of [{ ...precise, precision: 'approximate' }, { ...precise }, { ...precise, precision: 'nonsense' }]) {
            const res = await post(alice, location);
            expect(res.status).toBe(201);
            expect(res.body.location).toMatchObject({ lat: 28.61, lng: 77.21, precision: 'approximate' });
            const stored = await Review.findById(res.body.id).lean();
            expect(stored.location.lat).toBe(28.61);
            expect(stored.location.lng).toBe(77.21);
            // The map cell is derived from the coarse point, not from the real one.
            const { latLngToCell } = await import('h3-js');
            expect(stored.location.h3Index).toBe(latLngToCell(28.61, 77.21, 9));
            expect(stored.location.h3Index).not.toBe(latLngToCell(precise.lat, precise.lng, 9));
            expect(JSON.stringify(stored)).not.toContain('613912');
        }
    });

    it('exact coordinates are kept only when the reviewer asks for them', async (ctx) => {
        needsDb(ctx);
        const res = await post(alice, { ...precise, precision: 'exact' });
        expect(res.status).toBe(201);
        expect(res.body.location).toMatchObject({ ...precise, precision: 'exact' });
    });

    it('a review without a location is rejected instead of being pinned to a default place', async (ctx) => {
        needsDb(ctx);
        for (const location of [undefined, {}, { lat: null, lng: null }, { lat: '', lng: '' }, { lat: 28.6 }]) {
            const res = await post(alice, location);
            expect(res.status, JSON.stringify(location)).toBe(400);
            expect(res.body.error).toMatch(/location is required/i);
        }
        expect(await Review.countDocuments()).toBe(0);
    });

    it('no endpoint returns more precision than an approximate review allows', async (ctx) => {
        needsDb(ctx);
        // Stored with full precision (as if written by an older client) but marked approximate.
        const { latLngToCell } = await import('h3-js');
        const doc = await Review.create(reviewDoc({
            user: { id: alice._id, name: 'alice' },
            location: { city: 'Delhi', ...precise, precision: 'approximate', h3Index: latLngToCell(precise.lat, precise.lng, 9) }
        }));
        const responses = [
            await request(app).get('/api/reviews'),
            await request(app).get('/api/reviews').query({ limit: 10 }),
            await request(app).get(`/api/reviews/${doc._id}`),
            await request(app).get('/api/reviews/map-stats'),
            await request(app).put(`/api/reviews/${doc._id}`).set(auth(alice)).send({ review: { text: 'edited' } }),
            await request(app).patch(`/api/reviews/${doc._id}/purchase-info`).set(auth(alice)).send({ purchaseLink: '' })
        ];
        for (const res of responses) {
            expect(res.status).toBe(200);
            const text = JSON.stringify(res.body);
            expect(text).toContain('28.61');
            expect(text).not.toContain('28.613912');
            expect(text).not.toContain('77.209021');
        }
    });
});

describe('Uploads (Cloudinary stubbed)', () => {
    const png = (bytes) => Buffer.alloc(bytes, 1);
    const reviewData = JSON.stringify({ product: { name: 'Camera', category: 'Electronics' }, review: { text: 'Sharp', rating: 5 }, location: { lat: 28.6, lng: 77.2 } });
    const postReview = (user, file, type = 'image/png', name = 'a.png') => {
        const req = request(app).post('/api/reviews').set(auth(user)).field('data', reviewData);
        return file ? req.attach('images', file, { filename: name, contentType: type }) : req;
    };

    it('a normal upload is stored and counted against the quota', async (ctx) => {
        needsDb(ctx);
        const res = await postReview(alice, png(5000));
        expect(res.status).toBe(201);
        expect(uploadStub.uploads).toHaveLength(1);
        expect(res.body.review.media).toHaveLength(1);
        expect(res.body.review.media[0].size).toBe(5000);
        expect((await User.findById(alice._id)).totalMediaBytes).toBe(5000);
    });

    it('review create: nothing is uploaded when the quota is used up', async (ctx) => {
        needsDb(ctx);
        await User.findByIdAndUpdate(alice._id, { totalMediaBytes: MAX_MEDIA_LIMIT });
        const res = await postReview(alice, png(2000));
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toMatch(/Storage limit reached/);
        expect(uploadStub.uploads).toHaveLength(0);
        expect(await Review.countDocuments()).toBe(0);
        // A text-only review still works for the same user.
        expect((await postReview(alice, null)).status).toBe(201);
    });

    it('review create: a request larger than the remaining quota is refused before upload', async (ctx) => {
        needsDb(ctx);
        await User.findByIdAndUpdate(alice._id, { totalMediaBytes: MAX_MEDIA_LIMIT - 100 * 1024 });
        const res = await postReview(alice, png(400 * 1024));
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Storage limit reached/);
        expect(uploadStub.uploads).toHaveLength(0);
        expect((await User.findById(alice._id)).totalMediaBytes).toBe(MAX_MEDIA_LIMIT - 100 * 1024);
    });

    it('review edit: an over-quota edit uploads nothing and leaves the old media alone', async (ctx) => {
        needsDb(ctx);
        const old = 'https://res.cloudinary.com/test-cloud/image/upload/v1/reviewpedia/old.png';
        const review = await Review.create(reviewDoc({
            user: { id: alice._id, name: 'alice' },
            review: { title: 't', text: 'x', rating: 4, media: [{ type: 'image', url: old, size: 50 * 1024 }] }
        }));
        await User.findByIdAndUpdate(alice._id, { totalMediaBytes: MAX_MEDIA_LIMIT });
        const res = await request(app).put(`/api/reviews/${review._id}`).set(auth(alice))
            .field('data', JSON.stringify({ review: { text: 'x' }, existingMedia: [] }))
            .attach('images', png(600 * 1024), { filename: 'big.png', contentType: 'image/png' });
        expect(res.status).toBe(400);
        expect(uploadStub.uploads).toHaveLength(0);
        expect(uploadStub.destroyed).toHaveLength(0);
        expect((await Review.findById(review._id)).review.media.map(m => m.url)).toEqual([old]);
    });

    it('review edit: replacing media within the quota works and frees the old file afterwards', async (ctx) => {
        needsDb(ctx);
        const old = 'https://res.cloudinary.com/test-cloud/image/upload/v1/reviewpedia/old.png';
        const review = await Review.create(reviewDoc({
            user: { id: alice._id, name: 'alice' },
            review: { title: 't', text: 'x', rating: 4, media: [{ type: 'image', url: old, size: 3000 }] }
        }));
        await User.findByIdAndUpdate(alice._id, { totalMediaBytes: 3000 });
        const res = await request(app).put(`/api/reviews/${review._id}`).set(auth(alice))
            .field('data', JSON.stringify({ review: { text: 'x' }, existingMedia: [] }))
            .attach('images', png(4000), { filename: 'new.png', contentType: 'image/png' });
        expect(res.status).toBe(200);
        expect(res.body.review.media).toHaveLength(1);
        expect(res.body.review.media[0].size).toBe(4000);
        expect(uploadStub.destroyed).toEqual(['reviewpedia/old']);
        expect((await User.findById(alice._id)).totalMediaBytes).toBe(4000);
    });

    it('chat upload: nothing is uploaded when the quota is used up', async (ctx) => {
        needsDb(ctx);
        await User.findByIdAndUpdate(bob._id, { totalMediaBytes: MAX_MEDIA_LIMIT });
        const res = await request(app).post('/api/chat/upload').set(auth(bob))
            .attach('file', png(3000), { filename: 'c.png', contentType: 'image/png' });
        expect(res.status).toBe(400);
        expect(uploadStub.uploads).toHaveLength(0);

        await User.findByIdAndUpdate(bob._id, { totalMediaBytes: 0 });
        const ok = await request(app).post('/api/chat/upload').set(auth(bob))
            .attach('file', png(3000), { filename: 'c.png', contentType: 'image/png' });
        expect(ok.status).toBe(200);
        expect(ok.body.mediaSize).toBe(3000);
        expect(uploadStub.uploads).toHaveLength(1);
        expect(uploadStub.uploads[0].folder).toBe('reviewpedia_chat');
    });

    it('chat upload: the quota is charged atomically at upload time', async (ctx) => {
        needsDb(ctx);
        await User.findByIdAndUpdate(bob._id, { totalMediaBytes: MAX_MEDIA_LIMIT - 5000 });
        const up = () => request(app).post('/api/chat/upload').set(auth(bob))
            .attach('file', png(4000), { filename: 'c.png', contentType: 'image/png' });
        const results = await Promise.all([up(), up(), up()]);
        expect(results.filter(r => r.status === 200)).toHaveLength(1);
        expect(results.filter(r => r.status === 400)).toHaveLength(2);
        expect((await User.findById(bob._id)).totalMediaBytes).toBe(MAX_MEDIA_LIMIT - 1000);
        // The two refused files were removed again.
        expect(uploadStub.destroyed).toHaveLength(2);
    });

    it('chat media: only your own unsent upload can be attached, once, with its real size', async (ctx) => {
        needsDb(ctx);
        const convo = await Conversation.create({ participants: [alice._id, bob._id], lastMessage: 'x' });
        const uploaded = await request(app).post('/api/chat/upload').set(auth(bob))
            .attach('file', png(3000), { filename: 'c.png', contentType: 'image/png' });
        expect(uploaded.status).toBe(200);
        expect((await User.findById(bob._id)).totalMediaBytes).toBe(3000);
        const mediaUrl = uploaded.body.mediaUrl;
        const send = (user, extra = {}) => request(app).post('/api/chat/messages').set(auth(user))
            .send({ conversationId: convo._id.toString(), mediaUrl, ...extra });

        // Alice cannot attach bob's file.
        expect((await send(alice, { mediaType: 'image' })).status).toBe(400);
        // Bob can; the client-claimed size is ignored.
        const ok = await send(bob, { mediaType: 'image', mediaSize: 1 });
        expect(ok.status).toBe(200);
        expect(ok.body.message.mediaSize).toBe(3000);
        expect((await User.findById(bob._id)).totalMediaBytes).toBe(3000);
        // The same upload cannot be attached a second time.
        expect((await send(bob, { mediaType: 'image' })).status).toBe(400);

        // Deleting the message removes exactly that file and frees its bytes.
        uploadStub.destroyed.length = 0;
        expect((await request(app).delete(`/api/chat/messages/${ok.body.message._id}`).set(auth(bob))).status).toBe(200);
        expect(uploadStub.destroyed).toEqual([uploadStub.uploads[0].id]);
        expect((await User.findById(bob._id)).totalMediaBytes).toBe(0);
    });

    it('chat delete never removes files outside the chat folder (old messages)', async (ctx) => {
        needsDb(ctx);
        const convo = await Conversation.create({ participants: [alice._id, bob._id], lastMessage: 'x' });
        // A message stored before uploads were recorded, pointing at a review image.
        await Message.create({
            conversationId: convo._id, sender: bob._id, mediaType: 'image', mediaSize: 0,
            mediaUrl: 'https://res.cloudinary.com/test-cloud/image/upload/v1/reviewpedia/victim.jpg'
        });
        expect((await request(app).delete(`/api/chat/conversations/${convo._id}`).set(auth(bob))).status).toBe(200);
        expect(uploadStub.destroyed).toHaveLength(0);
    });

    it('review edit: an item left out of mediaOrder is removed and credited, extra uploads are discarded', async (ctx) => {
        needsDb(ctx);
        const keep = 'https://res.cloudinary.com/test-cloud/image/upload/v1/reviewpedia/keep.png';
        const drop = 'https://res.cloudinary.com/test-cloud/image/upload/v1/reviewpedia/drop.png';
        const review = await Review.create(reviewDoc({
            user: { id: alice._id, name: 'alice' },
            review: { title: 't', text: 'x', rating: 4, media: [{ type: 'image', url: keep, size: 1000 }, { type: 'image', url: drop, size: 2000 }] }
        }));
        await User.findByIdAndUpdate(alice._id, { totalMediaBytes: 3000 });
        const res = await request(app).put(`/api/reviews/${review._id}`).set(auth(alice))
            .field('data', JSON.stringify({
                review: { text: 'x' },
                existingMedia: [{ url: keep }, { url: drop }],
                mediaOrder: [{ type: 'existing', url: keep }, { type: 'new' }]
            }))
            .attach('images', png(500), { filename: 'a.png', contentType: 'image/png' })
            .attach('images', png(700), { filename: 'b.png', contentType: 'image/png' });
        expect(res.status).toBe(200);
        expect(res.body.review.media.map(m => m.url)).toEqual([keep, expect.stringContaining('reviewpedia/stub-1')]);
        // drop.png (left out of mediaOrder) and the unreferenced second upload are deleted.
        expect([...uploadStub.destroyed].sort()).toEqual(['reviewpedia/drop', 'reviewpedia/stub-2']);
        expect((await User.findById(alice._id)).totalMediaBytes).toBe(1500);
    });

    it('avatar: images only, 2 MB, and the picture cannot be set from a text field', async (ctx) => {
        needsDb(ctx);
        const put = () => request(app).put('/api/auth/profile').set(auth(alice)).field('username', 'alice').field('email', 'alice@example.com');

        const video = await put().attach('profilePic', png(4000), { filename: 'v.mp4', contentType: 'video/mp4' });
        expect(video.status).toBe(400);
        expect(video.body.error.message).toMatch(/Unsupported file type/);

        const huge = await put().attach('profilePic', png(3 * 1024 * 1024), { filename: 'big.png', contentType: 'image/png' });
        expect(huge.status).toBe(413);
        expect(JSON.stringify(huge.body)).toMatch(/max 2 MB/);

        // Just over the limit but inside the multipart allowance: stopped by the per-file limit.
        const over = await put().attach('profilePic', png(2 * 1024 * 1024 + 2000), { filename: 'over.png', contentType: 'image/png' });
        expect(over.status).toBe(413);
        expect(JSON.stringify(over.body)).toMatch(/max 2 MB/);
        expect((await User.findById(alice._id)).profilePic).toBe('');

        const sneaky = await put().field('profilePic', 'https://evil.example/x.png');
        expect(sneaky.status).toBe(200);
        expect((await User.findById(alice._id)).profilePic).toBe('');

        uploadStub.uploads.length = 0;
        const ok = await put().attach('profilePic', png(20000), { filename: 'me.png', contentType: 'image/png' });
        expect(ok.status).toBe(200);
        expect(uploadStub.uploads).toHaveLength(1);
        expect(ok.body.user.profilePic).toContain('res.cloudinary.com/test-cloud/');
    });

    it('replacing a profile picture removes the old file, and only from our own storage', async (ctx) => {
        needsDb(ctx);
        const put = () => request(app).put('/api/auth/profile').set(auth(alice)).field('username', 'alice').field('email', 'alice@example.com');

        // An old picture hosted somewhere else is never passed to the delete call.
        await User.updateOne({ _id: alice._id }, { profilePic: 'https://res.cloudinary.com/someone-else/image/upload/v1/reviewpedia/theirs.png' });
        uploadStub.destroyed.length = 0;
        expect((await put().attach('profilePic', png(20000), { filename: 'a.png', contentType: 'image/png' })).status).toBe(200);
        await new Promise(r => setTimeout(r, 50));
        expect(uploadStub.destroyed).toHaveLength(0);

        // Our own old picture is removed when a new one replaces it.
        await User.updateOne({ _id: alice._id }, { profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/v1/reviewpedia/old-avatar.png' });
        expect((await put().attach('profilePic', png(20000), { filename: 'b.png', contentType: 'image/png' })).status).toBe(200);
        await new Promise(r => setTimeout(r, 50));
        expect(uploadStub.destroyed).toEqual(['reviewpedia/old-avatar']);

        // A profile save without a new picture removes nothing.
        uploadStub.destroyed.length = 0;
        expect((await put()).status).toBe(200);
        await new Promise(r => setTimeout(r, 50));
        expect(uploadStub.destroyed).toHaveLength(0);
    });
});

describe('Usernames', () => {
    it('rule: 3-30 letters, digits, dot, underscore, hyphen', () => {
        for (const ok of ['abc', 'alice_01', 'a.b-c', 'A1b2C3', 'x'.repeat(30)]) expect(validateUsername(ok), ok).toBeNull();
        for (const bad of ['', 'ab', 'x'.repeat(31), 'has space', '<script>', 'a/b', '.abc', 'abc-', 'näme', 'a@b', null, {}, 42]) {
            expect(validateUsername(bad), String(bad)).toBeTruthy();
        }
    });

    it('sign-up rejects invalid usernames with a clear 400 before any code is sent or used', async (ctx) => {
        needsDb(ctx);
        for (const username of ['ab', 'has space', '<img src=x>', 'x'.repeat(31), { $ne: '' }]) {
            const res = await request(app).post('/api/auth/send-signup-otp').send({ email: 'new@example.com', username });
            expect(res.status, JSON.stringify(username)).toBe(400);
            expect(res.body.error).toMatch(/Username/);
        }
        expect(await EmailOtp.countDocuments()).toBe(0);

        await EmailOtp.create({ email: 'new@example.com', purpose: 'signup', otp: '111111' });
        const reg = await request(app).post('/api/auth/register').send({ username: 'bad name!', email: 'new@example.com', password: 'password9', otp: '111111' });
        expect(reg.status).toBe(400);
        expect(reg.body.error).toMatch(/3-30 characters/);
        expect((await EmailOtp.findOne({ email: 'new@example.com' })).attempts).toBe(0);   // code not spent
        expect(await User.countDocuments({ email: 'new@example.com' })).toBe(0);

        const good = await request(app).post('/api/auth/register').send({ username: 'good_name', email: 'new@example.com', password: 'password9', otp: '111111' });
        expect(good.status).toBe(201);
    });

    it('usernames are unique ignoring case', async (ctx) => {
        needsDb(ctx);
        const otp = await request(app).post('/api/auth/send-signup-otp').send({ email: 'new@example.com', username: 'ALICE' });
        expect(otp.status).toBe(400);
        const rename = await request(app).put('/api/auth/profile').set(auth(bob)).send({ username: 'Alice' });
        expect(rename.status).toBe(400);
        expect(rename.body.error).toMatch(/already taken/);
    });

    it('profile rename validates the new name; accounts with older names are not locked out', async (ctx) => {
        needsDb(ctx);
        const bad = await request(app).put('/api/auth/profile').set(auth(alice)).send({ username: 'not ok!' });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/3-30 characters/);
        const good = await request(app).put('/api/auth/profile').set(auth(alice)).send({ username: 'alice.new' });
        expect(good.status).toBe(200);
        expect(good.body.user.username).toBe('alice.new');

        // An account created before the rule, with a name the rule would refuse.
        const legacy = await User.create({ username: 'Old Name!', email: 'old@example.com', password: 'password5' });
        const login = await request(app).post('/api/auth/login').send({ email: 'old@example.com', password: 'password5' });
        expect(login.status).toBe(200);
        expect(login.body.user.username).toBe('Old Name!');
        expect((await request(app).get('/api/auth/me').set(auth(legacy))).status).toBe(200);
        // Saving the profile without changing the name still works.
        const keep = await request(app).put('/api/auth/profile').set(auth(legacy)).send({ username: 'Old Name!', email: 'old@example.com' });
        expect(keep.status).toBe(200);
        // It can post, too.
        const review = await request(app).post('/api/reviews').set(auth(legacy))
            .send({ product: { name: 'Mug' }, review: { text: 'ok', rating: 3 }, location: { lat: 12.97, lng: 77.59 } });
        expect(review.status).toBe(201);
    });
});

describe('Link preview: the validated address is the one connected to', () => {
    const html = '<html><head><title>Hello</title><meta property="og:description" content="Desc"></head></html>';
    const fakeResponse = (status, headers, body = '') => ({ status, headers, body: Readable.from([Buffer.from(body)]) });

    it('DNS is asked once and the connection is pinned to that answer (rebinding)', async () => {
        // First answer public, every later answer internal: the classic rebinding sequence.
        let lookups = 0;
        const rebindingLookup = async () => (++lookups === 1
            ? [{ address: '93.184.216.34', family: 4 }]
            : [{ address: '127.0.0.1', family: 4 }]);
        const calls = [];
        const request = async (options) => {
            calls.push(options);
            return fakeResponse(200, { 'content-type': 'text/html' }, html);
        };
        const meta = await fetchUrlMetadata('https://rebind.example/page', { lookup: rebindingLookup, request });
        expect(meta).toMatchObject({ title: 'Hello', description: 'Desc', url: 'https://rebind.example/page' });
        expect(lookups).toBe(1);
        expect(calls).toHaveLength(1);
        expect(calls[0].address).toBe('93.184.216.34');
        expect(calls[0].addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
        expect(calls[0].url.hostname).toBe('rebind.example');   // Host header / SNI still use the name
    });

    it('a redirect to a name that resolves internally is not followed', async () => {
        const lookup = async (host) => (host === 'public.example'
            ? [{ address: '93.184.216.34', family: 4 }]
            : [{ address: '10.0.0.7', family: 4 }]);
        const calls = [];
        const request = async (options) => {
            calls.push(options.url.href);
            return fakeResponse(302, { location: 'http://internal.example/admin' });
        };
        expect(await fetchUrlMetadata('http://public.example/', { lookup, request })).toBeNull();
        expect(calls).toEqual(['http://public.example/']);
    });

    it('each redirect hop is resolved, validated and pinned separately', async () => {
        const addresses = { 'a.example': '93.184.216.34', 'b.example': '151.101.1.69' };
        const lookup = async (host) => [{ address: addresses[host], family: 4 }];
        const calls = [];
        const request = async (options) => {
            calls.push([options.url.hostname, options.address]);
            return options.url.hostname === 'a.example'
                ? fakeResponse(301, { location: 'https://b.example/final' })
                : fakeResponse(200, { 'content-type': 'text/html; charset=utf-8' }, html);
        };
        const meta = await fetchUrlMetadata('https://a.example/', { lookup, request });
        expect(meta.url).toBe('https://b.example/final');
        expect(calls).toEqual([['a.example', '93.184.216.34'], ['b.example', '151.101.1.69']]);
    });

    it('pinnedLookup answers without DNS in both callback styles', () => {
        const lookup = pinnedLookup([{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1', family: 6 }]);
        lookup('whatever.example', { all: true }, (err, list) => {
            expect(err).toBeNull();
            expect(list).toEqual([{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1', family: 6 }]);
        });
        lookup('whatever.example', {}, (err, address, family) => {
            expect([err, address, family]).toEqual([null, '93.184.216.34', 4]);
        });
        lookup('whatever.example', (err, address) => expect(address).toBe('93.184.216.34'));
    });

    it('requestPinned really connects to the pinned address, not to what the name resolves to', async () => {
        // The hostname cannot be resolved at all (.invalid), so the request can only
        // succeed if the socket goes to the pinned address.
        const seen = [];
        const server = http.createServer((req, res) => {
            seen.push(req.headers.host);
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(html);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        try {
            const res = await requestPinned({ url: new URL(`http://pinned-host.invalid:${port}/x`), address: '127.0.0.1', family: 4 });
            expect(res.status).toBe(200);
            let body = '';
            for await (const chunk of res.body) body += chunk;
            expect(body).toContain('<title>Hello</title>');
            expect(seen).toEqual([`pinned-host.invalid:${port}`]);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});

describe('Cross-site requests and sessions', () => {
    it('state-changing requests from a foreign Origin are refused; our own origin is allowed', async (ctx) => {
        needsDb(ctx);
        const evil = await request(app).post('/api/auth/logout').set('Origin', 'https://evil.example');
        expect(evil.status).toBe(403);
        const nullOrigin = await request(app).post('/api/auth/logout').set('Origin', 'null');
        expect(nullOrigin.status).toBe(403);
        const ours = await request(app).post('/api/auth/logout').set('Origin', 'http://localhost:5173');
        expect(ours.status).toBe(200);
        // Reads are unaffected.
        expect((await request(app).get('/api/health').set('Origin', 'https://evil.example')).status).toBe(200);
    });

    it('a password reset ends sessions issued before it', async (ctx) => {
        needsDb(ctx);
        const login = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'password1' });
        expect(login.status).toBe(200);
        const oldToken = login.body.token;
        expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(200);

        await EmailOtp.create({ email: 'alice@example.com', purpose: 'forgot_password', otp: '123456' });
        const reset = await request(app).post('/api/auth/reset-password')
            .send({ email: 'alice@example.com', otp: '123456', newPassword: 'brand-new-pass' });
        expect(reset.status).toBe(200);

        expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(401);
        expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${reset.body.token}`)).status).toBe(200);
    });

    it('auth endpoints answer 400, not 500, for non-string input', async (ctx) => {
        needsDb(ctx);
        expect((await request(app).post('/api/auth/send-signup-otp').send({ email: ['a@b.c'], username: 'zed' })).status).toBe(400);
        expect((await request(app).post('/api/auth/send-forgot-password-otp').send({ email: { $ne: '' } })).status).toBe(400);
        expect((await request(app).post('/api/auth/reset-password')
            .send({ email: 'alice@example.com', otp: '123456', newPassword: ['a', 'b', 'c', 'd', 'e', 'f'] })).status).toBe(400);
    });

    it('purchase links must be web addresses', async (ctx) => {
        needsDb(ctx);
        const review = await Review.create(reviewDoc({ user: { id: alice._id, name: 'alice' } }));
        const patch = (body) => request(app).patch(`/api/reviews/${review._id}/purchase-info`).set(auth(alice)).send(body);
        expect((await patch({ purchaseLink: 'javascript:alert(1)' })).status).toBe(400);
        expect((await patch({ purchaseLink: 'x'.repeat(3000) })).status).toBe(400);
        const ok = await patch({ purchaseLink: 'https://shop.example/item', purchaseMeta: { title: 'Item', image: 'javascript:x' } });
        expect(ok.status).toBe(200);
        expect(ok.body.product.purchaseLink).toBe('https://shop.example/item');
        expect(ok.body.product.purchaseMeta.image).toBe('');
    });

    it('two simultaneous "start chat" requests create one conversation', async (ctx) => {
        needsDb(ctx);
        await Conversation.syncIndexes();
        const start = () => request(app).post('/api/chat/conversations').set(auth(alice)).send({ targetUsername: 'bob' });
        const results = await Promise.all([start(), start(), start()]);
        expect(results.every(r => r.status === 200)).toBe(true);
        expect(await Conversation.countDocuments()).toBe(1);
    });
});
