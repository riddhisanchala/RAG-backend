// server.js — entry point of the backend.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { connectDB } from './config/db.js';
import authRoutes from './routes/auth.js';
import providerRoutes from './routes/providers.js';
import knowledgeRoutes from './routes/knowledge.js';
import chatRoutes from './routes/chat.js';
import adminRoutes from './routes/admin.js';
import hrRoutes from './routes/hr.js';
import employeeRoutes from './routes/employee.js';
import { vectorStore } from './services/vector/faissStore.js';
import { ensureDefaultUsers } from './seed/defaultUsers.js';
import { shutdownOcr } from './services/ingestion/ocr.js';

export const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || /^http:\/\/localhost(:\d+)?$/.test(origin) || env.corsOrigin.includes(origin) || env.corsOrigin.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error('CORS blocked: ' + origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Secure RAG backend is running',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/providers', providerRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/hr', hrRoutes);
app.use('/api/employee', employeeRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.name === 'ValidationError' ? 400 : 500);
  if (status >= 500) console.error('❌', err);
  res.status(status).json({ error: status >= 500 && !err.isProviderError ? err.message || 'Internal server error' : err.message });
});

async function startServer() {
  await connectDB();

  vectorStore.init();
  const st = vectorStore.status();
  console.log(`✅ FAISS index loaded: ${st.total} vectors in ${st.partitions.length} partition(s)`);
  st.problems.forEach((p) => console.warn('⚠️ ', p));

  if (env.seedDefaultUsers) {
    try {
      const created = await ensureDefaultUsers();
      if (created.length) console.log('✅ Default users:', created.join(', '), '(login: admin / admin)');
    } catch (error) {
      // A seeding problem must not stop the API from starting.
      console.error('⚠️  Could not create default users:', error.message);
    }
  }

  const server = app.listen(env.port, () => console.log(`✅ Backend running at http://localhost:${env.port}`));
  const stop = async () => {
    server.close();
    await shutdownOcr();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

startServer();
