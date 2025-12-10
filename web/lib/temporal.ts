import { Client, Connection } from '@temporalio/client';

// Re-export shared constants
export { TASK_QUEUE } from './types';

let client: Client | null = null;
let connectionPromise: Promise<Connection> | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (client) return client;

  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

  if (!connectionPromise) {
    // Reset cache on failure so subsequent requests can retry
    connectionPromise = Connection.connect({ address }).catch((err) => {
      connectionPromise = null;
      client = null;
      throw err;
    });
  }

  const connection = await connectionPromise;
  client = new Client({ connection });

  return client;
}
