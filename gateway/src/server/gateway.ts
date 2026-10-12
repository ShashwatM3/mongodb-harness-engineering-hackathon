import { CallOrchestrator } from './calls/orchestrator';
import { ElevenLabsTwilioProvider, ScriptedCallProvider, SimulatedCallProvider, type CallProvider } from './calls/providers';
import { buildCallVariables } from './calls/variables';
import type { Config } from './config';
import { connectDatabase, type Database } from './db';
import { DecisionService, FeedbackDispatcher } from './domain/decisions';
import { EventLog } from './domain/events';
import { IncidentService } from './domain/incidents';
import { ProposalEngine } from './domain/proposals';
import { SupervisorQueries } from './domain/queries';
import type { HarnessAdapter } from './harness/adapter';
import { HttpHarnessAdapter } from './harness/http-adapter';
import { MockHarness } from './harness/mock/mock-harness';
import { FactLookupSupervisor, type SupervisorBrain } from './harness/mock/supervisor';

export interface Gateway {
  config: Config;
  db: Database;
  events: EventLog;
  harness: HarnessAdapter;
  mock: MockHarness | null;
  incidents: IncidentService;
  proposals: ProposalEngine;
  decisions: DecisionService;
  dispatcher: FeedbackDispatcher;
  calls: CallOrchestrator;
  queries: SupervisorQueries;
  /** Run one pass of background work (calls, outbox). Tests call this directly instead of waiting for timers. */
  tick(): Promise<void>;
  startWorkers(intervalMs?: number): void;
  stop(): Promise<void>;
}

export interface GatewayOverrides {
  harness?: HarnessAdapter;
  brain?: SupervisorBrain;
  provider?: CallProvider;
  db?: Database;
}

async function defaultBrain(config: Config): Promise<SupervisorBrain> {
  if (!config.ANTHROPIC_API_KEY) {
    console.warn('[gateway] ANTHROPIC_API_KEY not set: mock supervisor uses deterministic fact lookup (no reasoning).');
    return new FactLookupSupervisor();
  }
  const { ClaudeGroundedSupervisor } = await import('./harness/mock/claude-supervisor');
  return new ClaudeGroundedSupervisor(config.ANTHROPIC_API_KEY, config.MOCK_SUPERVISOR_MODEL, new FactLookupSupervisor());
}

async function defaultProvider(config: Config): Promise<CallProvider> {
  if (config.CALL_MODE === 'scripted') return new ScriptedCallProvider();
  if (config.CALL_MODE === 'simulated') return new SimulatedCallProvider();
  const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
  if (!config.ELEVENLABS_API_KEY) throw new Error('CALL_MODE=twilio needs ELEVENLABS_API_KEY');
  return new ElevenLabsTwilioProvider(new ElevenLabsClient({ apiKey: config.ELEVENLABS_API_KEY }) as never, {
    route: config.PHONE_ROUTE,
    agentId: config.ELEVENLABS_AGENT_ID,
    phoneNumberId: config.ELEVENLABS_PHONE_NUMBER_ID,
    allowedNumbers: config.CALL_ALLOWED_NUMBERS.split(',').map((n) => n.trim()).filter(Boolean),
    defaultNumber: config.SUPERVISOR_PHONE,
    ringingTimeoutSecs: Math.round(config.CALL_RING_TIMEOUT_MS / 1000),
  });
}

export async function createGateway(config: Config, o: GatewayOverrides = {}): Promise<Gateway> {
  const db = o.db ?? (await connectDatabase(config.MONGODB_URI, config.MONGODB_DB));
  const events = new EventLog(db);

  let mock: MockHarness | null = null;
  let harness: HarnessAdapter;
  if (o.harness) harness = o.harness;
  else if (config.HARNESS_MODE === 'http') harness = new HttpHarnessAdapter(config.HARNESS_BASE_URL, config.HARNESS_OUTBOUND_TOKEN, config.HARNESS_TIMEOUT_MS);
  else harness = mock = new MockHarness(o.brain ?? (await defaultBrain(config)));
  if (o.harness instanceof MockHarness) mock = o.harness;

  const provider = o.provider ?? (await defaultProvider(config));

  const incidents = new IncidentService(db, events);
  const proposals = new ProposalEngine(db, events, incidents, harness, config.HARNESS_TIMEOUT_MS);
  const dispatcher = new FeedbackDispatcher(db, events, incidents, harness, config.HARNESS_TIMEOUT_MS);
  let kick = () => {};
  const decisions = new DecisionService(db, events, incidents, () => kick());
  const calls = new CallOrchestrator(
    db,
    events,
    incidents,
    provider,
    {
    ringTimeoutMs: config.CALL_RING_TIMEOUT_MS,
    connectTimeoutMs: config.CALL_CONNECT_TIMEOUT_MS,
    retryDelayMs: config.CALL_RETRY_DELAY_MS,
    maxAttempts: config.CALL_MAX_ATTEMPTS,
    },
    (call, inc) => buildCallVariables({ proposals, harness }, inc, call._id),
  );
  const queries = new SupervisorQueries(db, events, incidents, harness, config.SUPERVISOR_SYNC_BUDGET_MS, config.HARNESS_TIMEOUT_MS * 6);

  let timer: NodeJS.Timeout | null = null;
  let ticking: Promise<void> | null = null;
  const tick = async () => {
    if (ticking) return ticking;
    ticking = (async () => {
      try {
        await proposals.releaseStaleLocks(2 * config.HARNESS_TIMEOUT_MS);
        await calls.tick();
        await dispatcher.tick();
      } catch (err) {
        console.error('[gateway] worker tick failed', err);
      } finally {
        ticking = null;
      }
    })();
    return ticking;
  };

  return {
    config,
    db,
    events,
    harness,
    mock,
    incidents,
    proposals,
    decisions,
    dispatcher,
    calls,
    queries,
    tick,
    startWorkers(intervalMs = 1000) {
      kick = () => void dispatcher.tick().catch((err) => console.error('[gateway] dispatch failed', err));
      timer = setInterval(() => void tick(), intervalMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      await ticking;
      await db.close();
    },
  };
}
