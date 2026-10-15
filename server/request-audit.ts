import type { GatewayId } from './gateway.ts';
import type { RequestEvent } from './request-evidence.ts';

export interface RequestAuditSnapshot {
  source: 'local-poc-memory';
  gatewayId: GatewayId;
  startedAt: string;
  capturedAt: string;
  capacity: number;
  events: RequestEvent[];
}

export class RequestAudit {
  private readonly events: RequestEvent[] = [];
  private readonly startedAt = new Date().toISOString();
  private readonly capacity = 40;

  record(event: RequestEvent): void {
    this.events.push(structuredClone(event));
    if (this.events.length > this.capacity) this.events.shift();
  }

  snapshot(gatewayId: GatewayId): RequestAuditSnapshot {
    return {
      source: 'local-poc-memory', gatewayId, startedAt: this.startedAt,
      capturedAt: new Date().toISOString(), capacity: this.capacity,
      events: structuredClone(this.events.filter(event => event.gatewayId === gatewayId).toReversed())
    };
  }
}
