// Clears the gateway's own collections (incidents, plans, feedback, calls, questions, audit) for a clean demo.
// Touches only MONGODB_DB (default intervention_gateway); never other databases on the cluster.
//   npm run reset:db -- --yes
import { MongoClient } from 'mongodb';

const COLLECTIONS = ['incidents', 'proposal_heads', 'proposal_revisions', 'decisions', 'calls', 'supervisor_queries', 'audit_events', 'webhook_receipts', 'executions', 'supervisors'];
const uri = process.env.MONGODB_URI ?? '';
const dbName = process.env.MONGODB_DB || 'intervention_gateway';
if (!uri || uri === 'memory') throw new Error('MONGODB_URI is not set to a real database');
if (!process.argv.includes('--yes')) {
  console.log(`This deletes all documents in ${COLLECTIONS.join(', ')} of database "${dbName}". Re-run with --yes.`);
  process.exit(1);
}
const client = await MongoClient.connect(uri);
const db = client.db(dbName);
for (const c of COLLECTIONS) {
  const { deletedCount } = await db.collection(c).deleteMany({});
  if (deletedCount) console.log(`✓ ${c}: deleted ${deletedCount}`);
}
await client.close();
console.log(`✓ ${dbName} is empty (indexes kept)`);
