// Shows which database we are connected to and what it contains.
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import dns from 'node:dns';

dotenv.config();
dns.setServers(['8.8.8.8', '8.8.4.4']);

try {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to database:', mongoose.connection.name);

  const collections = await mongoose.connection.db.listCollections().toArray();
  console.log('Collections:', collections.map((c) => c.name));

  for (const c of collections) {
    const count = await mongoose.connection.db.collection(c.name).countDocuments();
    console.log(`  ${c.name}: ${count} documents`);
  }
} catch (error) {
  console.error('Check failed:', error.message);
}
await mongoose.disconnect();
