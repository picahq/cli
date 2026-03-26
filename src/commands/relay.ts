import pc from 'picocolors';
import { getApiKey, getAccessControlFromAllSources } from '../lib/config.js';
import { OneApi } from '../lib/api.js';
import { printTable } from '../lib/table.js';
import * as output from '../lib/output.js';

function getConfig() {
  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('Not configured. Run `one init` first.');
  }

  const ac = getAccessControlFromAllSources();
  const connectionKeys: string[] = ac.connectionKeys || ['*'];
  return { apiKey, connectionKeys };
}

function parseJsonArg(value: string, argName: string): any {
  try {
    return JSON.parse(value);
  } catch {
    output.error(`Invalid JSON for ${argName}: ${value}`);
  }
}

// ── Commands ──

export async function relayCreateCommand(options: {
  connectionKey: string;
  description?: string;
  eventFilters?: string;
  tags?: string;
  createWebhook?: boolean;
}): Promise<void> {
  const { apiKey, connectionKeys } = getConfig();

  if (!connectionKeys.includes('*') && !connectionKeys.includes(options.connectionKey)) {
    output.error(`Connection key "${options.connectionKey}" is not allowed.`);
  }

  const api = new OneApi(apiKey);
  const spinner = output.createSpinner();
  spinner.start('Creating relay endpoint...');

  try {
    const body: Record<string, unknown> = {
      connectionKey: options.connectionKey,
    };
    if (options.description) body.description = options.description;
    if (options.eventFilters) body.eventFilters = parseJsonArg(options.eventFilters, '--event-filters');
    if (options.tags) body.tags = parseJsonArg(options.tags, '--tags');
    if (options.createWebhook) body.createWebhook = true;

    const result = await api.createRelayEndpoint(body as any);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop('Relay endpoint created');
    console.log();
    console.log(`  ${pc.dim('ID:')}          ${result.id}`);
    console.log(`  ${pc.dim('URL:')}         ${result.url}`);
    console.log(`  ${pc.dim('Active:')}      ${result.active}`);
    if (result.description) console.log(`  ${pc.dim('Description:')} ${result.description}`);
    if (result.eventFilters?.length) console.log(`  ${pc.dim('Events:')}      ${result.eventFilters.join(', ')}`);
    if (result.webhookPayload?.id) console.log(`  ${pc.dim('Webhook ID:')}  ${result.webhookPayload.id}`);
    console.log();
  } catch (error) {
    spinner.stop('Failed to create relay endpoint');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayListCommand(options: {
  limit?: string;
  page?: string;
}): Promise<void> {
  const { apiKey } = getConfig();
  const api = new OneApi(apiKey);
  const spinner = output.createSpinner();
  spinner.start('Loading relay endpoints...');

  try {
    const query: Record<string, string> = {};
    if (options.limit) query.limit = options.limit;
    if (options.page) query.page = options.page;

    const result = await api.listRelayEndpoints(query);
    const endpoints = result.rows || [];

    if (output.isAgentMode()) {
      output.json({
        total: result.total,
        showing: endpoints.length,
        endpoints: endpoints.map((e: any) => ({
          id: e.id,
          active: e.active,
          description: e.description,
          eventFilters: e.eventFilters,
          actionsCount: e.actions?.length || 0,
          url: e.url,
          createdAt: e.createdAt,
        })),
      });
      return;
    }

    spinner.stop(`${endpoints.length} relay endpoint${endpoints.length === 1 ? '' : 's'} found`);

    if (endpoints.length === 0) {
      console.log('\n  No relay endpoints yet.\n');
      return;
    }

    printTable(
      ['Status', 'Description', 'Events', 'Actions', 'ID'],
      endpoints.map((e: any) => [
        e.active ? pc.green('●') : pc.dim('○'),
        e.description || pc.dim('(none)'),
        e.eventFilters?.join(', ') || pc.dim('all'),
        String(e.actions?.length || 0),
        pc.dim(e.id.slice(0, 8)),
      ])
    );
  } catch (error) {
    spinner.stop('Failed to list relay endpoints');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayGetCommand(id: string): Promise<void> {
  const { apiKey } = getConfig();
  const api = new OneApi(apiKey);
  const spinner = output.createSpinner();
  spinner.start('Loading relay endpoint...');

  try {
    const result = await api.getRelayEndpoint(id);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop('Relay endpoint loaded');
    console.log();
    console.log(`  ${pc.dim('ID:')}          ${result.id}`);
    console.log(`  ${pc.dim('URL:')}         ${result.url}`);
    console.log(`  ${pc.dim('Active:')}      ${result.active}`);
    if (result.description) console.log(`  ${pc.dim('Description:')} ${result.description}`);
    if (result.eventFilters?.length) console.log(`  ${pc.dim('Events:')}      ${result.eventFilters.join(', ')}`);
    console.log(`  ${pc.dim('Actions:')}     ${result.actions?.length || 0}`);
    if (result.actions?.length) {
      for (const [i, action] of result.actions.entries()) {
        console.log(`    ${pc.dim(`[${i}]`)} type=${action.type}${action.actionId ? ` actionId=${action.actionId}` : ''}${action.url ? ` url=${action.url}` : ''}`);
      }
    }
    console.log(`  ${pc.dim('Created:')}     ${result.createdAt}`);
    console.log();
  } catch (error) {
    spinner.stop('Failed to load relay endpoint');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayUpdateCommand(
  id: string,
  options: {
    description?: string;
    active?: boolean;
    eventFilters?: string;
    tags?: string;
    actions?: string;
  }
): Promise<void> {
  const { apiKey } = getConfig();
  const api = new OneApi(apiKey);
  const spinner = output.createSpinner();
  spinner.start('Updating relay endpoint...');

  try {
    const body: Record<string, unknown> = {};
    if (options.description !== undefined) body.description = options.description;
    if (options.active !== undefined) body.active = options.active;
    if (options.eventFilters) body.eventFilters = parseJsonArg(options.eventFilters, '--event-filters');
    if (options.tags) body.tags = parseJsonArg(options.tags, '--tags');
    if (options.actions) body.actions = parseJsonArg(options.actions, '--actions');

    const result = await api.updateRelayEndpoint(id, body);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop('Relay endpoint updated');
    console.log(`  ${pc.dim('ID:')} ${result.id}`);
    console.log(`  ${pc.dim('Active:')} ${result.active}`);
    console.log(`  ${pc.dim('Actions:')} ${result.actions?.length || 0}`);
    console.log();
  } catch (error) {
    spinner.stop('Failed to update relay endpoint');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayDeleteCommand(id: string): Promise<void> {
  const { apiKey } = getConfig();
  const api = new OneApi(apiKey);
  const spinner = output.createSpinner();
  spinner.start('Deleting relay endpoint...');

  try {
    const result = await api.deleteRelayEndpoint(id);

    if (output.isAgentMode()) {
      output.json({ deleted: true, id: result.id });
      return;
    }

    spinner.stop('Relay endpoint deleted');
    console.log(`  Deleted: ${result.id}`);
    console.log();
  } catch (error) {
    spinner.stop('Failed to delete relay endpoint');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayActivateCommand(
  id: string,
  options: { actions: string; webhookSecret?: string }
): Promise<void> {
  const { apiKey } = getConfig();
  const api = new OneApi(apiKey);
  const spinner = output.createSpinner();
  spinner.start('Activating relay endpoint...');

  try {
    const actions = parseJsonArg(options.actions, '--actions');
    const body: Record<string, unknown> = { actions };
    if (options.webhookSecret) body.webhookSecret = options.webhookSecret;

    const result = await api.activateRelayEndpoint(id, body as any);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop('Relay endpoint activated');
    console.log(`  ${pc.dim('ID:')} ${result.id}`);
    console.log(`  ${pc.dim('Active:')} ${result.active}`);
    console.log(`  ${pc.dim('Actions:')} ${result.actions?.length || 0}`);
    console.log();
  } catch (error) {
    spinner.stop('Failed to activate relay endpoint');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayEventsCommand(options: {
  limit?: string;
  page?: string;
  platform?: string;
  eventType?: string;
  after?: string;
  before?: string;
}): Promise<void> {
  const { apiKey } = getConfig();
  const api = new OneApi(apiKey);
  const spinner = output.createSpinner();
  spinner.start('Loading relay events...');

  try {
    const query: Record<string, string> = {};
    if (options.limit) query.limit = options.limit;
    if (options.page) query.page = options.page;
    if (options.platform) query.platform = options.platform;
    if (options.eventType) query.eventType = options.eventType;
    if (options.after) query.after = options.after;
    if (options.before) query.before = options.before;

    const result = await api.listRelayEvents(query);
    const events = result.rows || [];

    if (output.isAgentMode()) {
      output.json({
        total: result.total,
        showing: events.length,
        events: events.map((e: any) => ({
          id: e.id,
          platform: e.platform,
          eventType: e.eventType,
          timestamp: e.timestamp || e.createdAt,
        })),
      });
      return;
    }

    spinner.stop(`${events.length} event${events.length === 1 ? '' : 's'} found`);

    if (events.length === 0) {
      console.log('\n  No events found.\n');
      return;
    }

    printTable(
      ['Platform', 'Event Type', 'Timestamp', 'ID'],
      events.map((e: any) => [
        e.platform,
        e.eventType || pc.dim('unknown'),
        e.timestamp || e.createdAt,
        pc.dim(e.id.slice(0, 8)),
      ])
    );
  } catch (error) {
    spinner.stop('Failed to list relay events');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayEventGetCommand(id: string): Promise<void> {
  const { apiKey } = getConfig();
  const api = new OneApi(apiKey);
  const spinner = output.createSpinner();
  spinner.start('Loading relay event...');

  try {
    const result = await api.getRelayEvent(id);

    if (output.isAgentMode()) {
      output.json(result);
      return;
    }

    spinner.stop('Relay event loaded');
    console.log();
    console.log(`  ${pc.dim('ID:')}        ${result.id}`);
    console.log(`  ${pc.dim('Platform:')}  ${result.platform}`);
    console.log(`  ${pc.dim('Event:')}     ${result.eventType}`);
    console.log(`  ${pc.dim('Timestamp:')} ${result.timestamp || result.createdAt}`);
    console.log(`  ${pc.dim('Payload:')}`);
    console.log(JSON.stringify(result.payload, null, 2));
    console.log();
  } catch (error) {
    spinner.stop('Failed to load relay event');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayDeliveriesCommand(options: {
  endpointId?: string;
  eventId?: string;
}): Promise<void> {
  if (!options.endpointId && !options.eventId) {
    output.error('Provide either --endpoint-id or --event-id');
  }

  const { apiKey } = getConfig();
  const api = new OneApi(apiKey);
  const spinner = output.createSpinner();
  spinner.start('Loading deliveries...');

  try {
    const deliveries = options.endpointId
      ? await api.listRelayEndpointDeliveries(options.endpointId)
      : await api.listRelayEventDeliveries(options.eventId!);

    const items = Array.isArray(deliveries) ? deliveries : deliveries.rows || [];

    if (output.isAgentMode()) {
      output.json({ deliveries: items });
      return;
    }

    spinner.stop(`${items.length} deliver${items.length === 1 ? 'y' : 'ies'} found`);

    if (items.length === 0) {
      console.log('\n  No deliveries found.\n');
      return;
    }

    printTable(
      ['Status', 'Code', 'Attempt', 'Delivered At', 'Error'],
      items.map((d: any) => [
        d.status === 'success' ? pc.green(d.status) : pc.red(d.status),
        d.statusCode != null ? String(d.statusCode) : pc.dim('-'),
        String(d.attempt),
        d.deliveredAt || pc.dim('-'),
        d.error ? pc.red(d.error.slice(0, 50)) : pc.dim('-'),
      ])
    );
  } catch (error) {
    spinner.stop('Failed to load deliveries');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function relayEventTypesCommand(platform: string): Promise<void> {
  const { apiKey } = getConfig();
  const api = new OneApi(apiKey);
  const spinner = output.createSpinner();
  spinner.start(`Loading event types for ${pc.cyan(platform)}...`);

  try {
    const eventTypes = await api.listRelayEventTypes(platform);

    if (output.isAgentMode()) {
      output.json({ platform, eventTypes });
      return;
    }

    spinner.stop(`${eventTypes.length} event type${eventTypes.length === 1 ? '' : 's'} found`);

    if (eventTypes.length === 0) {
      console.log(`\n  No event types found for ${platform}.\n`);
      return;
    }

    console.log();
    for (const type of eventTypes) {
      console.log(`  ${type}`);
    }
    console.log();
  } catch (error) {
    spinner.stop('Failed to load event types');
    output.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
