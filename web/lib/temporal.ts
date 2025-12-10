import { Client, Connection } from '@temporalio/client';

let client: Client | null = null;
let connectionPromise: Promise<Connection> | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (client) return client;

  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

  if (!connectionPromise) {
    connectionPromise = Connection.connect({ address });
  }

  const connection = await connectionPromise;
  client = new Client({ connection });

  return client;
}

export const TASK_QUEUE = 'guide-generation';
